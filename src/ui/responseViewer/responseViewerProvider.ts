import * as vscode from 'vscode';
import { DisposeProvider } from '../../utils';
import { UIResponse } from '../types';
import * as httpyac from 'httpyac';

/**
 * Provider for a dedicated response viewer panel
 */
export class ResponseViewerProvider extends DisposeProvider {
  private panel: vscode.WebviewPanel | undefined;
  private currentResponse: UIResponse | undefined;
  private activeTab: 'body' | 'headers' | 'cookies' | 'tests' | 'timings' = 'body';

  constructor(private readonly extensionUri: vscode.Uri) {
    super();
  }

  /**
   * Show a response in the viewer
   */
  async showResponse(response: UIResponse): Promise<void> {
    this.currentResponse = response;

    if (!this.panel) {
      this.panel = this.createWebviewPanel();
    }

    this.panel.reveal(vscode.ViewColumn.Two);
    this.updateWebview();
  }

  /**
   * Create the webview panel
   */
  private createWebviewPanel(): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
      'httpyac.responseViewer',
      'Response',
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
      }
    );

    panel.webview.html = this.getWebviewContent(panel.webview);

    panel.webview.onDidReceiveMessage(message => this.handleMessage(message));

    panel.onDidDispose(() => {
      this.panel = undefined;
    });

    this.subscriptions.push(panel);

    return panel;
  }

  /**
   * Update the webview with current response
   */
  private updateWebview(): void {
    if (!this.panel || !this.currentResponse) return;

    const statusText = this.currentResponse.statusCode >= 400 ? 'error' : 'success';
    this.panel.title = `Response ${this.currentResponse.statusCode}`;

    this.panel.webview.postMessage({
      type: 'responseLoaded',
      payload: {
        response: this.currentResponse,
        activeTab: this.activeTab,
      },
    });
  }

  /**
   * Handle messages from the webview
   */
  private async handleMessage(message: { type: string; payload?: unknown }): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.updateWebview();
        break;

      case 'switchTab':
        this.activeTab = message.payload as typeof this.activeTab;
        break;

      case 'copy':
        await this.copyToClipboard(message.payload as string);
        break;

      case 'save':
        await this.saveResponse();
        break;

      case 'format':
        this.formatBody();
        break;
    }
  }

  /**
   * Copy content to clipboard
   */
  private async copyToClipboard(content: string): Promise<void> {
    await vscode.env.clipboard.writeText(content);
    vscode.window.showInformationMessage('Copied to clipboard');
  }

  /**
   * Save response to file
   */
  private async saveResponse(): Promise<void> {
    if (!this.currentResponse) return;

    const defaultName = `response-${this.currentResponse.statusCode}.${this.getExtension()}`;
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(defaultName),
      filters: {
        'All Files': ['*'],
        JSON: ['json'],
        XML: ['xml'],
        HTML: ['html'],
        Text: ['txt'],
      },
    });

    if (uri) {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(this.currentResponse.body, 'utf-8'));
      vscode.window.showInformationMessage(`Response saved to ${uri.fsPath}`);
    }
  }

  /**
   * Get file extension based on body type
   */
  private getExtension(): string {
    switch (this.currentResponse?.bodyType) {
      case 'json':
        return 'json';
      case 'xml':
        return 'xml';
      case 'html':
        return 'html';
      default:
        return 'txt';
    }
  }

  /**
   * Format the body content
   */
  private formatBody(): void {
    if (!this.currentResponse || this.currentResponse.bodyType !== 'json') return;

    try {
      const formatted = JSON.stringify(JSON.parse(this.currentResponse.body), null, 2);
      this.currentResponse.body = formatted;
      this.updateWebview();
    } catch {
      // Not valid JSON, ignore
    }
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
  <title>Response Viewer</title>
  <style>
    :root {
      --container-padding: 16px;
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
    
    /* Status Bar */
    .status-bar {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 12px 16px;
      background: var(--vscode-sideBar-background);
      border-radius: var(--border-radius);
    }
    
    .status-badge {
      font-weight: 600;
      font-size: 14px;
      padding: 4px 12px;
      border-radius: var(--border-radius);
    }
    
    .status-badge.success {
      background: rgba(40, 167, 69, 0.2);
      color: #28a745;
    }
    
    .status-badge.error {
      background: rgba(220, 53, 69, 0.2);
      color: #dc3545;
    }
    
    .status-badge.redirect {
      background: rgba(255, 193, 7, 0.2);
      color: #ffc107;
    }
    
    .meta-info {
      display: flex;
      gap: 20px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    
    .meta-item {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    
    .meta-label {
      opacity: 0.7;
    }
    
    .meta-value {
      font-weight: 500;
    }
    
    .actions {
      margin-left: auto;
      display: flex;
      gap: 8px;
    }
    
    .action-btn {
      padding: 4px 12px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: var(--border-radius);
      font-size: 12px;
      cursor: pointer;
      transition: background 0.15s;
    }
    
    .action-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    
    /* Tabs */
    .tabs {
      display: flex;
      gap: 4px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    
    .tab {
      padding: 8px 16px;
      background: transparent;
      color: var(--vscode-foreground);
      border: none;
      border-bottom: 2px solid transparent;
      cursor: pointer;
      font-size: 13px;
      opacity: 0.7;
      transition: opacity 0.15s;
    }
    
    .tab:hover {
      opacity: 1;
    }
    
    .tab.active {
      opacity: 1;
      border-bottom-color: var(--vscode-focusBorder);
    }
    
    .tab .badge {
      margin-left: 6px;
      padding: 1px 6px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-radius: 10px;
      font-size: 10px;
    }
    
    /* Tab Content */
    .tab-content {
      flex: 1;
      overflow: hidden;
    }
    
    .tab-panel {
      display: none;
      height: 100%;
      overflow: auto;
    }
    
    .tab-panel.active {
      display: block;
    }
    
    /* Body Content */
    .body-content {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: var(--border-radius);
      padding: 16px;
      font-family: var(--vscode-editor-font-family);
      font-size: 13px;
      white-space: pre-wrap;
      word-break: break-all;
      overflow: auto;
      height: calc(100% - 16px);
    }
    
    /* JSON Syntax Highlighting */
    .json-key { color: var(--vscode-symbolIcon-propertyForeground, #9cdcfe); }
    .json-string { color: var(--vscode-symbolIcon-stringForeground, #ce9178); }
    .json-number { color: var(--vscode-symbolIcon-numberForeground, #b5cea8); }
    .json-boolean { color: var(--vscode-symbolIcon-booleanForeground, #569cd6); }
    .json-null { color: var(--vscode-symbolIcon-nullForeground, #569cd6); }
    
    /* Headers Table */
    .headers-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    
    .headers-table th,
    .headers-table td {
      text-align: left;
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    
    .headers-table th {
      background: var(--vscode-sideBar-background);
      font-weight: 600;
      color: var(--vscode-foreground);
    }
    
    .headers-table td:first-child {
      width: 200px;
      font-weight: 500;
      color: var(--vscode-symbolIcon-propertyForeground, #9cdcfe);
    }
    
    .headers-table td:last-child {
      word-break: break-all;
    }
    
    .headers-table tr:hover {
      background: var(--vscode-list-hoverBackground);
    }
    
    /* Test Results */
    .test-results {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 8px 0;
    }
    
    .test-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      background: var(--vscode-sideBar-background);
      border-radius: var(--border-radius);
    }
    
    .test-icon {
      font-size: 16px;
    }
    
    .test-icon.pass { color: #28a745; }
    .test-icon.fail { color: #dc3545; }
    
    .test-name {
      flex: 1;
      font-weight: 500;
    }
    
    .test-message {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    
    /* Timings */
    .timings-chart {
      padding: 16px 0;
    }
    
    .timing-row {
      display: flex;
      align-items: center;
      margin-bottom: 12px;
    }
    
    .timing-label {
      width: 120px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    
    .timing-bar-container {
      flex: 1;
      height: 20px;
      background: var(--vscode-sideBar-background);
      border-radius: var(--border-radius);
      overflow: hidden;
      margin-right: 12px;
    }
    
    .timing-bar {
      height: 100%;
      border-radius: var(--border-radius);
      transition: width 0.3s ease;
    }
    
    .timing-bar.dns { background: #4e79a7; }
    .timing-bar.tcp { background: #f28e2c; }
    .timing-bar.tls { background: #e15759; }
    .timing-bar.request { background: #76b7b2; }
    .timing-bar.firstByte { background: #59a14f; }
    .timing-bar.download { background: #edc949; }
    
    .timing-value {
      width: 60px;
      text-align: right;
      font-size: 12px;
      font-weight: 500;
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
      <h2>No response yet</h2>
      <p>Send a request to see the response here</p>
    </div>
  </div>
  
  <script nonce="${nonce}">
    (function() {
      const vscode = acquireVsCodeApi();
      let state = {
        response: null,
        activeTab: 'body'
      };
      
      // Handle messages from extension
      window.addEventListener('message', event => {
        const message = event.data;
        
        if (message.type === 'responseLoaded') {
          state.response = message.payload.response;
          state.activeTab = message.payload.activeTab || 'body';
          render();
        }
      });
      
      // Send ready message
      vscode.postMessage({ type: 'ready' });
      
      // Render function
      function render() {
        const app = document.getElementById('app');
        
        if (!state.response) {
          app.innerHTML = \`
            <div class="empty-state">
              <h2>No response yet</h2>
              <p>Send a request to see the response here</p>
            </div>
          \`;
          return;
        }
        
        const res = state.response;
        const statusClass = res.statusCode < 300 ? 'success' : res.statusCode < 400 ? 'redirect' : 'error';
        const headerCount = Object.keys(res.headers || {}).length;
        const testCount = res.testResults?.length || 0;
        const passedTests = res.testResults?.filter(t => t.result).length || 0;
        
        app.innerHTML = \`
          <div class="status-bar">
            <span class="status-badge \${statusClass}">
              \${res.statusCode} \${res.statusText}
            </span>
            <div class="meta-info">
              <span class="meta-item">
                <span class="meta-label">Size:</span>
                <span class="meta-value">\${formatBytes(res.size)}</span>
              </span>
              <span class="meta-item">
                <span class="meta-label">Time:</span>
                <span class="meta-value">\${res.time}ms</span>
              </span>
            </div>
            <div class="actions">
              <button class="action-btn" onclick="copyBody()">Copy</button>
              <button class="action-btn" onclick="saveResponse()">Save</button>
              <button class="action-btn" onclick="formatBody()">Format</button>
            </div>
          </div>
          
          <div class="tabs">
            <button class="tab \${state.activeTab === 'body' ? 'active' : ''}" data-tab="body">Response</button>
            <button class="tab \${state.activeTab === 'headers' ? 'active' : ''}" data-tab="headers">
              Headers<span class="badge">\${headerCount}</span>
            </button>
            <button class="tab \${state.activeTab === 'cookies' ? 'active' : ''}" data-tab="cookies">
              Cookies<span class="badge">\${(res.cookies || []).length}</span>
            </button>
            \${testCount > 0 ? \`
              <button class="tab \${state.activeTab === 'tests' ? 'active' : ''}" data-tab="tests">
                Tests<span class="badge">\${passedTests}/\${testCount}</span>
              </button>
            \` : ''}
            \${res.timings ? \`
              <button class="tab \${state.activeTab === 'timings' ? 'active' : ''}" data-tab="timings">Timings</button>
            \` : ''}
          </div>
          
          <div class="tab-content">
            <div class="tab-panel \${state.activeTab === 'body' ? 'active' : ''}" id="body-panel">
              <div class="body-content">\${formatResponseBody(res.body, res.bodyType)}</div>
            </div>
            
            <div class="tab-panel \${state.activeTab === 'headers' ? 'active' : ''}" id="headers-panel">
              <table class="headers-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  \${Object.entries(res.headers || {}).map(([key, value]) => \`
                    <tr>
                      <td>\${escapeHtml(key)}</td>
                      <td>\${escapeHtml(String(value))}</td>
                    </tr>
                  \`).join('')}
                </tbody>
              </table>
            </div>
            
            <div class="tab-panel \${state.activeTab === 'cookies' ? 'active' : ''}" id="cookies-panel">
              \${(res.cookies || []).length > 0 ? \`
                <table class="headers-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    \${(res.cookies || []).map(c => \`
                      <tr>
                        <td>\${escapeHtml(c.name)}</td>
                        <td>\${escapeHtml(c.value)}</td>
                      </tr>
                    \`).join('')}
                  </tbody>
                </table>
              \` : '<p style="padding: 16px; color: var(--vscode-descriptionForeground);">No cookies in response</p>'}
            </div>
            
            \${testCount > 0 ? \`
              <div class="tab-panel \${state.activeTab === 'tests' ? 'active' : ''}" id="tests-panel">
                <div class="test-results">
                  \${res.testResults.map(t => \`
                    <div class="test-item">
                      <span class="test-icon \${t.result ? 'pass' : 'fail'}">\${t.result ? '✓' : '✗'}</span>
                      <span class="test-name">\${escapeHtml(t.message || 'Test')}</span>
                      \${t.error ? \`<span class="test-message">\${escapeHtml(t.error.message || '')}</span>\` : ''}
                    </div>
                  \`).join('')}
                </div>
              </div>
            \` : ''}
            
            \${res.timings ? \`
              <div class="tab-panel \${state.activeTab === 'timings' ? 'active' : ''}" id="timings-panel">
                <div class="timings-chart">
                  \${renderTimings(res.timings)}
                </div>
              </div>
            \` : ''}
          </div>
        \`;
        
        // Attach tab click handlers
        document.querySelectorAll('.tab').forEach(tab => {
          tab.addEventListener('click', () => {
            state.activeTab = tab.dataset.tab;
            vscode.postMessage({ type: 'switchTab', payload: state.activeTab });
            render();
          });
        });
      }
      
      function renderTimings(timings) {
        const total = timings.total || 1;
        const items = [
          { label: 'DNS Lookup', key: 'dns', value: timings.dns || 0 },
          { label: 'TCP Connect', key: 'tcp', value: timings.tcp || 0 },
          { label: 'TLS Handshake', key: 'tls', value: timings.tls || 0 },
          { label: 'Request', key: 'request', value: timings.request || 0 },
          { label: 'First Byte', key: 'firstByte', value: timings.firstByte || 0 },
          { label: 'Download', key: 'download', value: timings.download || 0 },
        ].filter(i => i.value > 0);
        
        return items.map(item => \`
          <div class="timing-row">
            <span class="timing-label">\${item.label}</span>
            <div class="timing-bar-container">
              <div class="timing-bar \${item.key}" style="width: \${Math.max(2, (item.value / total) * 100)}%"></div>
            </div>
            <span class="timing-value">\${item.value}ms</span>
          </div>
        \`).join('');
      }
      
      function formatResponseBody(body, type) {
        if (!body) return '<span style="color: var(--vscode-descriptionForeground);">Empty response</span>';
        
        if (type === 'json') {
          try {
            const formatted = JSON.stringify(JSON.parse(body), null, 2);
            return syntaxHighlightJSON(formatted);
          } catch {
            return escapeHtml(body);
          }
        }
        
        return escapeHtml(body);
      }
      
      function syntaxHighlightJSON(json) {
        return json.replace(/("(\\\\u[a-zA-Z0-9]{4}|\\\\[^u]|[^\\\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, function (match) {
          let cls = 'json-number';
          if (/^"/.test(match)) {
            if (/:$/.test(match)) {
              cls = 'json-key';
            } else {
              cls = 'json-string';
            }
          } else if (/true|false/.test(match)) {
            cls = 'json-boolean';
          } else if (/null/.test(match)) {
            cls = 'json-null';
          }
          return '<span class="' + cls + '">' + escapeHtml(match) + '</span>';
        });
      }
      
      window.copyBody = function() {
        vscode.postMessage({ type: 'copy', payload: state.response?.body || '' });
      };
      
      window.saveResponse = function() {
        vscode.postMessage({ type: 'save' });
      };
      
      window.formatBody = function() {
        vscode.postMessage({ type: 'format' });
      };
      
      function escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
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

