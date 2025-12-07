import * as vscode from 'vscode';
import { DisposeProvider } from '../../utils';
import { DocumentStore } from '../../documentStore';
import { ResponseStore } from '../../responseStore';
import { FileSyncService } from '../sync';
import { UIRequest, UIResponse, WebviewMessage, ExtensionMessage, Environment } from '../types';
import * as httpyac from 'httpyac';

/**
 * Provider for the request editor webview panel
 */
export class RequestEditorProvider extends DisposeProvider {
  private panel: vscode.WebviewPanel | undefined;
  private currentRequest: UIRequest | undefined;
  private environments: Environment[] = [];
  private activeEnvironment: string | undefined;

  // Cancellation support
  private cancellationTokenSource: vscode.CancellationTokenSource | undefined;
  private isRequestInProgress = false;

  private readonly _onRequestSent = new vscode.EventEmitter<{ request: UIRequest; response: UIResponse }>();
  readonly onRequestSent = this._onRequestSent.event;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly documentStore: DocumentStore,
    private readonly responseStore: ResponseStore,
    private readonly fileSyncService: FileSyncService
  ) {
    super();

    // Listen for environment changes
    fileSyncService.onEnvironmentsChanged(envs => {
      this.environments = envs;
      this.postMessage({ type: 'environmentChanged', payload: { environments: envs, active: this.activeEnvironment } });
    });

    this.subscriptions = [this._onRequestSent];
  }

  /**
   * Show a request in the editor
   */
  async showRequest(request: UIRequest): Promise<void> {
    this.currentRequest = request;

    if (!this.panel) {
      this.panel = this.createWebviewPanel();
    }

    this.panel.reveal(vscode.ViewColumn.One);
    await this.updateWebview();
  }

  /**
   * Create the webview panel
   */
  private createWebviewPanel(): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel('httpyac.requestEditor', 'Request Editor', vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    });

    panel.webview.html = this.getWebviewContent(panel.webview);

    panel.webview.onDidReceiveMessage(message => this.handleMessage(message));

    panel.onDidDispose(() => {
      this.panel = undefined;
    });

    this.subscriptions.push(panel);

    return panel;
  }

  /**
   * Update the webview with current request
   */
  private async updateWebview(): Promise<void> {
    if (!this.panel || !this.currentRequest) return;

    this.panel.title = this.currentRequest.name || 'Request Editor';

    this.postMessage({
      type: 'requestLoaded',
      payload: {
        request: this.currentRequest,
        environments: this.environments,
        activeEnvironment: this.activeEnvironment,
      },
    });
  }

  /**
   * Handle messages from the webview
   */
  private async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.updateWebview();
        break;

      case 'send':
        await this.sendRequest();
        break;

      case 'save':
        await this.saveRequest(message.payload as UIRequest);
        break;

      case 'updateRequest': {
        // Restore proper fileUri from the original request (webview serialization loses Uri methods)
        const updatedRequest = message.payload as UIRequest;
        if (this.currentRequest?.fileUri) {
          updatedRequest.fileUri = this.currentRequest.fileUri;
        }
        this.currentRequest = updatedRequest;
        await this.saveRequest(this.currentRequest);
        break;
      }

      case 'selectEnvironment':
        this.activeEnvironment = message.payload as string;
        this.postMessage({
          type: 'environmentChanged',
          payload: { environments: this.environments, active: this.activeEnvironment },
        });
        break;

      case 'cancel':
        this.cancelRequest();
        break;

      case 'openRawView':
        await this.openRawView();
        break;

      default:
        // Ignore unknown message types
        break;
    }
  }

  /**
   * Send the current request
   */
  private async sendRequest(): Promise<void> {
    if (!this.currentRequest?.fileUri) return;

    // Cancel any existing request
    if (this.isRequestInProgress) {
      this.cancelRequest();
    }

    // Create new cancellation token
    this.cancellationTokenSource = new vscode.CancellationTokenSource();
    const token = this.cancellationTokenSource.token;
    this.isRequestInProgress = true;

    // Update status to pending
    this.postMessage({ type: 'requestProgress', payload: { status: 'pending' } });

    try {
      // IMPORTANT: Save current request immediately before sending
      // This ensures any pending changes are written to disk
      await this.fileSyncService.saveRequest(this.currentRequest, true);

      // Small delay to ensure file system has flushed
      await new Promise(resolve => setTimeout(resolve, 50));

      // Clear httpyac cache for this file to ensure we get fresh content
      const fileUri = this.ensureUri(this.currentRequest.fileUri);
      this.documentStore.httpFileStore.remove(fileUri);

      // Open the document and execute with httpyac
      const doc = await vscode.workspace.openTextDocument(fileUri);
      const httpFile = await this.documentStore.getHttpFile(doc);

      if (!httpFile || httpFile.httpRegions.length === 0) {
        throw new Error('No HTTP regions found in file');
      }

      // Check if cancelled before starting
      if (token.isCancellationRequested) {
        throw new Error('Request cancelled');
      }

      const httpRegion = httpFile.httpRegions[0];
      const env = this.activeEnvironment ? [this.activeEnvironment] : undefined;

      // Variable to capture the response from the callback
      let capturedResponse: httpyac.HttpResponse | undefined;
      let capturedHttpRegion: httpyac.HttpRegion | undefined;

      // Create context with proper callbacks
      const context: httpyac.HttpRegionSendContext = {
        httpFile,
        httpRegion,
        activeEnvironment: env,
        progress: {
          divider: 1,
          isCanceled: () => token.isCancellationRequested,
          register: (event: () => void) => {
            const dispose = token.onCancellationRequested(event);
            return () => dispose.dispose();
          },
          report: () => {
            // Progress updates could be sent to webview if needed
          },
        },
        // This callback receives the response when the request completes
        logResponse: async (response, region) => {
          if (response) {
            capturedResponse = response;
            capturedHttpRegion = region;
          }
        },
      };

      const result = await this.documentStore.send(context);

      // Check if cancelled after request
      if (token.isCancellationRequested) {
        throw new Error('Request cancelled');
      }

      // Try to get response from multiple sources
      if (capturedResponse) {
        const response = this.convertResponse(capturedResponse, capturedHttpRegion);
        this.postMessage({ type: 'responseReceived', payload: response });
        this._onRequestSent.fire({ request: this.currentRequest, response });
      } else if (httpRegion.response) {
        // Fallback: check if response is on httpRegion directly
        const response = this.convertResponse(httpRegion.response, httpRegion);
        this.postMessage({ type: 'responseReceived', payload: response });
        this._onRequestSent.fire({ request: this.currentRequest, response });
      } else if (!result) {
        // Request returned false - likely an error or disabled region
        this.postMessage({
          type: 'error',
          payload: { message: 'Request failed or was skipped. Check the httpYac output for details.' },
        });
      } else {
        // Request succeeded but no response captured
        this.postMessage({
          type: 'error',
          payload: { message: 'Request completed but no response was captured. This might be a streaming request.' },
        });
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const isCancelled = errorMessage === 'Request cancelled' || token.isCancellationRequested;

      if (isCancelled) {
        this.postMessage({ type: 'requestCancelled', payload: { message: 'Request cancelled' } });
      } else {
        this.postMessage({ type: 'error', payload: { message: errorMessage } });
      }
    } finally {
      this.isRequestInProgress = false;
      this.cancellationTokenSource?.dispose();
      this.cancellationTokenSource = undefined;
    }
  }

  /**
   * Cancel the current request
   */
  private cancelRequest(): void {
    if (this.cancellationTokenSource && this.isRequestInProgress) {
      this.cancellationTokenSource.cancel();
      httpyac.io.log.info('Request cancelled by user');
    }
  }

  /**
   * Convert httpyac response to UIResponse
   */
  private convertResponse(response: httpyac.HttpResponse, httpRegion?: httpyac.HttpRegion): UIResponse {
    const headers: Record<string, string> = {};
    if (response.headers) {
      for (const [key, value] of Object.entries(response.headers)) {
        headers[key] = Array.isArray(value) ? value.join(', ') : String(value);
      }
    }

    // Ensure body is a string
    let body = '';
    if (response.body) {
      if (httpyac.utils.isString(response.body)) {
        body = response.body;
      } else {
        body = httpyac.utils.stringifySafe(response.body, 2);
      }
    }

    return {
      id: `response-${Date.now()}`,
      requestId: this.currentRequest?.id || '',
      statusCode: response.statusCode,
      statusText: response.statusMessage || '',
      headers,
      cookies: [], // TODO: Parse cookies from headers
      body,
      bodyType: this.detectBodyType(response.contentType),
      size: response.rawBody?.length || 0,
      time: response.timings?.total || 0,
      timings: response.timings,
      testResults: httpRegion?.testResults,
    };
  }

  /**
   * Detect body type from content type
   */
  private detectBodyType(contentType?: httpyac.ContentType): 'json' | 'xml' | 'html' | 'text' | 'binary' {
    if (!contentType) return 'text';

    if (httpyac.utils.isMimeTypeJSON(contentType)) return 'json';
    if (httpyac.utils.isMimeTypeXml(contentType)) return 'xml';
    if (httpyac.utils.isMimeTypeHtml(contentType)) return 'html';

    return 'text';
  }

  /**
   * Ensure a URI-like object is a proper vscode.Uri
   */
  private ensureUri(uri: vscode.Uri | { scheme?: string; path?: string; fsPath?: string }): vscode.Uri {
    if (uri && typeof (uri as vscode.Uri).with === 'function') {
      return uri as vscode.Uri;
    }
    const fsPath = (uri as { fsPath?: string }).fsPath || (uri as { path?: string }).path;
    if (fsPath) {
      return vscode.Uri.file(fsPath);
    }
    const uriString = uri?.toString?.();
    if (uriString && uriString.startsWith('file://')) {
      return vscode.Uri.parse(uriString);
    }
    throw new Error('Invalid URI object');
  }

  /**
   * Save the current request
   */
  private async saveRequest(request: UIRequest): Promise<void> {
    this.currentRequest = request;
    await this.fileSyncService.saveRequest(request);
  }

  /**
   * Open the raw .http file in editor
   */
  private async openRawView(): Promise<void> {
    if (!this.currentRequest?.fileUri) return;

    const doc = await vscode.workspace.openTextDocument(this.currentRequest.fileUri);
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
  }

  /**
   * Post a message to the webview
   */
  private postMessage(message: ExtensionMessage): void {
    this.panel?.webview.postMessage(message);
  }

  /**
   * Get the webview HTML content
   */
  private getWebviewContent(webview: vscode.Webview): string {
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Request Editor</title>
  <style>
    :root {
      --vscode-font-family: var(--vscode-editor-font-family, 'SF Mono', Consolas, monospace);
      --container-padding: 16px;
      --input-height: 32px;
      --border-radius: 4px;
    }
    
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: var(--container-padding);
      line-height: 1.5;
    }
    
    .container {
      display: flex;
      flex-direction: column;
      height: calc(100vh - 32px);
      gap: 16px;
    }
    
    /* URL Bar */
    .url-bar {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    
    .method-select {
      min-width: 100px;
      height: var(--input-height);
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
      border-radius: var(--border-radius);
      padding: 0 8px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }
    
    .method-select option {
      background: var(--vscode-dropdown-background);
    }
    
    .url-input {
      flex: 1;
      height: var(--input-height);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: var(--border-radius);
      padding: 0 12px;
      font-size: 13px;
    }
    
    .url-input:focus {
      outline: none;
      border-color: var(--vscode-focusBorder);
    }
    
    .send-btn {
      height: var(--input-height);
      padding: 0 20px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: var(--border-radius);
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 90px;
      justify-content: center;
    }

    .send-btn:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .send-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .send-btn.loading {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }

    .send-btn.loading:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .send-btn .spinner-small {
      width: 14px;
      height: 14px;
      border: 2px solid currentColor;
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
    }
    
    /* Tabs */
    .tabs-container {
      display: flex;
      flex-direction: column;
      flex: 1;
      overflow: hidden;
    }
    
    .tabs {
      display: flex;
      gap: 4px;
      border-bottom: 1px solid var(--vscode-panel-border);
      padding-bottom: 8px;
    }
    
    .tab {
      padding: 8px 16px;
      background: transparent;
      color: var(--vscode-foreground);
      border: none;
      border-radius: var(--border-radius) var(--border-radius) 0 0;
      cursor: pointer;
      font-size: 13px;
      opacity: 0.7;
      transition: opacity 0.15s, background 0.15s;
    }
    
    .tab:hover {
      opacity: 1;
      background: var(--vscode-list-hoverBackground);
    }
    
    .tab.active {
      opacity: 1;
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    
    .tab-content {
      flex: 1;
      overflow: auto;
      padding: 16px 0;
    }
    
    .tab-panel {
      display: none;
      height: 100%;
    }
    
    .tab-panel.active {
      display: block;
    }
    
    /* Key-Value Editor */
    .kv-editor {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    
    .kv-row {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    
    .kv-checkbox {
      width: 16px;
      height: 16px;
      cursor: pointer;
    }
    
    .kv-input {
      flex: 1;
      height: 28px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: var(--border-radius);
      padding: 0 8px;
      font-size: 12px;
    }
    
    .kv-input:focus {
      outline: none;
      border-color: var(--vscode-focusBorder);
    }
    
    .kv-remove {
      width: 28px;
      height: 28px;
      background: transparent;
      color: var(--vscode-foreground);
      border: none;
      border-radius: var(--border-radius);
      cursor: pointer;
      opacity: 0.5;
      transition: opacity 0.15s;
    }
    
    .kv-remove:hover {
      opacity: 1;
      background: var(--vscode-list-hoverBackground);
    }
    
    .add-row-btn {
      align-self: flex-start;
      padding: 6px 12px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: var(--border-radius);
      font-size: 12px;
      cursor: pointer;
      margin-top: 8px;
    }
    
    .add-row-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    
    /* Body Editor */
    .body-editor {
      height: 100%;
      display: flex;
      flex-direction: column;
    }
    
    .body-type-select {
      width: 200px;
      height: 28px;
      margin-bottom: 12px;
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
      border-radius: var(--border-radius);
      padding: 0 8px;
      font-size: 12px;
    }
    
    .body-textarea {
      flex: 1;
      min-height: 200px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: var(--border-radius);
      padding: 12px;
      font-family: var(--vscode-editor-font-family);
      font-size: 13px;
      resize: none;
    }
    
    .body-textarea:focus {
      outline: none;
      border-color: var(--vscode-focusBorder);
    }
    
    /* Response Panel */
    .response-panel {
      border-top: 1px solid var(--vscode-panel-border);
      padding-top: 16px;
      flex: 1;
    }
    
    .response-header {
      display: flex;
      align-items: center;
      gap: 16px;
      margin-bottom: 12px;
    }
    
    .response-status {
      font-weight: 600;
      padding: 4px 12px;
      border-radius: var(--border-radius);
    }
    
    .response-status.success {
      background: rgba(40, 167, 69, 0.2);
      color: #28a745;
    }
    
    .response-status.error {
      background: rgba(220, 53, 69, 0.2);
      color: #dc3545;
    }
    
    .response-status.cancelled {
      background: rgba(108, 117, 125, 0.2);
      color: #6c757d;
    }
    
    .response-meta {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    
    .response-body {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: var(--border-radius);
      padding: 12px;
      overflow: auto;
      max-height: 300px;
      font-family: var(--vscode-editor-font-family);
      font-size: 13px;
      white-space: pre-wrap;
    }
    
    /* Loading State */
    .loading {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 40px;
      color: var(--vscode-descriptionForeground);
    }
    
    .spinner {
      width: 24px;
      height: 24px;
      border: 2px solid var(--vscode-foreground);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-right: 12px;
    }
    
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    
    /* Empty State */
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--vscode-descriptionForeground);
      text-align: center;
    }
    
    .empty-state h2 {
      margin-bottom: 8px;
      font-weight: 500;
    }
  </style>
</head>
<body>
  <div class="container" id="app">
    <div class="empty-state">
      <h2>Select a request to edit</h2>
      <p>Choose a request from the Collections panel</p>
    </div>
  </div>
  
  <script nonce="${nonce}">
    (function() {
      const vscode = acquireVsCodeApi();
      let state = {
        request: null,
        response: null,
        environments: [],
        activeEnvironment: null,
        loading: false,
        activeTab: 'headers'
      };
      
      // Handle messages from extension
      window.addEventListener('message', event => {
        const message = event.data;
        
        switch (message.type) {
          case 'requestLoaded':
            state.request = message.payload.request;
            state.environments = message.payload.environments || [];
            state.activeEnvironment = message.payload.activeEnvironment;
            state.response = null;
            render();
            break;
            
          case 'responseReceived':
            state.response = message.payload;
            state.loading = false;
            render();
            break;
            
          case 'requestProgress':
            state.loading = message.payload.status === 'pending';
            render();
            break;
            
          case 'error':
            state.loading = false;
            state.response = {
              statusCode: 0,
              statusText: 'Error',
              body: message.payload.message,
              bodyType: 'text',
              size: 0,
              time: 0,
              isError: true
            };
            render();
            break;
            
          case 'requestCancelled':
            state.loading = false;
            state.response = {
              statusCode: 0,
              statusText: 'Cancelled',
              body: 'Request was cancelled by user',
              bodyType: 'text',
              size: 0,
              time: 0,
              cancelled: true
            };
            render();
            break;
            
          case 'environmentChanged':
            state.environments = message.payload.environments || [];
            state.activeEnvironment = message.payload.active;
            render();
            break;
        }
      });
      
      // Send ready message
      vscode.postMessage({ type: 'ready' });
      
      // Render function
      function render() {
        const app = document.getElementById('app');
        
        if (!state.request) {
          app.innerHTML = \`
            <div class="empty-state">
              <h2>Select a request to edit</h2>
              <p>Choose a request from the Collections panel</p>
            </div>
          \`;
          return;
        }
        
        const req = state.request;
        const headers = req.headers || [];
        const params = req.queryParams || [];
        
        app.innerHTML = \`
          <div class="url-bar">
            <select class="method-select" id="method">
              \${['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].map(m => 
                \`<option value="\${m}" \${req.method === m ? 'selected' : ''}>\${m}</option>\`
              ).join('')}
            </select>
            <input type="text" class="url-input" id="url" value="\${escapeHtml(req.url || '')}" placeholder="Enter request URL">
            <button class="send-btn \${state.loading ? 'loading' : ''}" id="sendBtn">
              \${state.loading ? '<div class="spinner-small"></div>Sending...' : 'Send'}
            </button>
          </div>
          
          <div class="tabs-container">
            <div class="tabs">
              <button class="tab \${state.activeTab === 'params' ? 'active' : ''}" data-tab="params">Query</button>
              <button class="tab \${state.activeTab === 'headers' ? 'active' : ''}" data-tab="headers">Headers</button>
              <button class="tab \${state.activeTab === 'body' ? 'active' : ''}" data-tab="body">Body</button>
              <button class="tab \${state.activeTab === 'auth' ? 'active' : ''}" data-tab="auth">Auth</button>
            </div>
            
            <div class="tab-content">
              <div class="tab-panel \${state.activeTab === 'params' ? 'active' : ''}" id="params-panel">
                <div class="kv-editor" id="params-editor">
                  \${renderKVRows(params, 'param')}
                </div>
                <button class="add-row-btn" data-add-type="param">+ Add Parameter</button>
              </div>

              <div class="tab-panel \${state.activeTab === 'headers' ? 'active' : ''}" id="headers-panel">
                <div class="kv-editor" id="headers-editor">
                  \${renderKVRows(headers, 'header')}
                </div>
                <button class="add-row-btn" data-add-type="header">+ Add Header</button>
              </div>
              
              <div class="tab-panel \${state.activeTab === 'body' ? 'active' : ''}" id="body-panel">
                <div class="body-editor">
                  <select class="body-type-select" id="bodyType">
                    \${['none', 'json', 'form', 'raw'].map(t => 
                      \`<option value="\${t}" \${req.body?.type === t ? 'selected' : ''}>\${t.toUpperCase()}</option>\`
                    ).join('')}
                  </select>
                  <textarea class="body-textarea" id="bodyContent" placeholder="Request body...">\${escapeHtml(req.body?.content || '')}</textarea>
                </div>
              </div>
              
              <div class="tab-panel \${state.activeTab === 'auth' ? 'active' : ''}" id="auth-panel">
                <p style="color: var(--vscode-descriptionForeground)">
                  Authentication configuration can be added using httpyac metadata in the raw .http file.
                </p>
              </div>
            </div>
          </div>
          
          \${state.loading ? \`
            <div class="response-panel">
              <div class="loading">
                <div class="spinner"></div>
                <span>Sending request... Click Cancel to abort</span>
              </div>
            </div>
          \` : state.response ? \`
            <div class="response-panel">
              <div class="response-header">
                <span class="response-status \${state.response.cancelled ? 'cancelled' : state.response.isError ? 'error' : state.response.statusCode < 400 ? 'success' : 'error'}">
                  \${state.response.cancelled ? '⊘ Cancelled' : state.response.isError ? '⚠ Error' : state.response.statusCode + ' ' + state.response.statusText}
                </span>
                \${!state.response.cancelled && !state.response.isError && state.response.size !== undefined ? \`<span class="response-meta">
                  Size: \${formatBytes(state.response.size || 0)} • Time: \${state.response.time || 0}ms
                </span>\` : ''}
              </div>
              <pre class="response-body">\${escapeHtml(formatBody(state.response.body, state.response.bodyType))}</pre>
            </div>
          \` : ''}
        \`;
        
        attachEventListeners();
      }
      
      function renderKVRows(items, type) {
        if (!items || items.length === 0) {
          return \`<div class="kv-row">
            <input type="checkbox" class="kv-checkbox" checked data-type="\${type}" data-index="0" data-field="enabled">
            <input type="text" class="kv-input" placeholder="Key" data-type="\${type}" data-index="0" data-field="key">
            <input type="text" class="kv-input" placeholder="Value" data-type="\${type}" data-index="0" data-field="value">
            <button class="kv-remove" data-remove-type="\${type}" data-remove-index="0">×</button>
          </div>\`;
        }

        return items.map((item, i) => \`
          <div class="kv-row">
            <input type="checkbox" class="kv-checkbox" \${item.enabled !== false ? 'checked' : ''} data-type="\${type}" data-index="\${i}" data-field="enabled">
            <input type="text" class="kv-input" placeholder="Key" value="\${escapeHtml(item.key || '')}" data-type="\${type}" data-index="\${i}" data-field="key">
            <input type="text" class="kv-input" placeholder="Value" value="\${escapeHtml(item.value || '')}" data-type="\${type}" data-index="\${i}" data-field="value">
            <button class="kv-remove" data-remove-type="\${type}" data-remove-index="\${i}">×</button>
          </div>
        \`).join('');
      }
      
      function attachEventListeners() {
        // Tab switching
        document.querySelectorAll('.tab').forEach(tab => {
          tab.addEventListener('click', () => {
            state.activeTab = tab.dataset.tab;
            render();
          });
        });
        
        // Method change
        const methodSelect = document.getElementById('method');
        if (methodSelect) {
          methodSelect.addEventListener('change', () => {
            state.request.method = methodSelect.value;
            updateRequest();
          });
        }
        
        // URL change
        const urlInput = document.getElementById('url');
        if (urlInput) {
          urlInput.addEventListener('input', () => {
            state.request.url = urlInput.value;
            updateRequest();
          });
        }
        
        // Send/Cancel button
        const sendBtn = document.getElementById('sendBtn');
        if (sendBtn) {
          sendBtn.addEventListener('click', () => {
            if (state.loading) {
              vscode.postMessage({ type: 'cancel' });
            } else {
              vscode.postMessage({ type: 'send' });
            }
          });
        }
        
        // Body type change
        const bodyType = document.getElementById('bodyType');
        if (bodyType) {
          bodyType.addEventListener('change', () => {
            state.request.body = state.request.body || {};
            state.request.body.type = bodyType.value;
            updateRequest();
          });
        }
        
        // Body content change
        const bodyContent = document.getElementById('bodyContent');
        if (bodyContent) {
          bodyContent.addEventListener('input', () => {
            state.request.body = state.request.body || {};
            state.request.body.content = bodyContent.value;
            updateRequest();
          });
        }
        
        // KV inputs
        document.querySelectorAll('.kv-input, .kv-checkbox').forEach(input => {
          input.addEventListener('change', handleKVChange);
          input.addEventListener('input', handleKVChange);
        });

        // Add row buttons
        document.querySelectorAll('.add-row-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            const type = e.target.dataset.addType;
            if (type) {
              addRow(type);
            }
          });
        });

        // Remove row buttons
        document.querySelectorAll('.kv-remove').forEach(btn => {
          btn.addEventListener('click', (e) => {
            const type = e.target.dataset.removeType;
            const index = parseInt(e.target.dataset.removeIndex, 10);
            if (type !== undefined && !isNaN(index)) {
              removeRow(type, index);
            }
          });
        });
      }
      
      function handleKVChange(e) {
        const { type, index, field } = e.target.dataset;
        const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
        
        const arrayName = type === 'header' ? 'headers' : 'queryParams';
        if (!state.request[arrayName]) state.request[arrayName] = [];
        if (!state.request[arrayName][index]) state.request[arrayName][index] = { key: '', value: '', enabled: true };
        
        state.request[arrayName][index][field] = value;
        updateRequest();
      }
      
      function addRow(type) {
        const arrayName = type === 'header' ? 'headers' : 'queryParams';
        if (!state.request[arrayName]) state.request[arrayName] = [];
        state.request[arrayName].push({ key: '', value: '', enabled: true });
        render();
      }

      function removeRow(type, index) {
        const arrayName = type === 'header' ? 'headers' : 'queryParams';
        if (state.request[arrayName]) {
          state.request[arrayName].splice(index, 1);
          render();
          updateRequest();
        }
      }
      
      function updateRequest() {
        vscode.postMessage({ type: 'updateRequest', payload: state.request });
      }
      
      function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
      }
      
      function formatBody(body, type) {
        if (type === 'json') {
          try {
            return JSON.stringify(JSON.parse(body), null, 2);
          } catch {
            return body;
          }
        }
        return body;
      }
      
      function formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
      }
      
      // Initial render
      render();
    })();
  </script>
</body>
</html>`;
  }
}

/**
 * Generate a nonce for CSP
 */
function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
