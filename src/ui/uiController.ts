import * as vscode from 'vscode';
import { DisposeProvider } from '../utils';
import { getUIConfig } from '../config';
import { DocumentStore } from '../documentStore';
import { ResponseStore } from '../responseStore';
import { FileSyncService } from './sync';
import { CollectionsTreeProvider } from './collectionsPanel';
import { RequestEditorProvider } from './requestEditor';
import { UIRequest } from './types';

/**
 * Main controller for the REST Client UI
 */
export class UIController extends DisposeProvider {
  private fileSyncService: FileSyncService;
  private collectionsTreeProvider: CollectionsTreeProvider | undefined;
  private requestEditorProvider: RequestEditorProvider | undefined;
  private isEnabled: boolean;
  private extensionUri: vscode.Uri | undefined;

  constructor(
    private readonly documentStore: DocumentStore,
    private readonly responseStore: ResponseStore
  ) {
    super();

    const config = getUIConfig();
    this.isEnabled = config.enabled ?? true;
    this.fileSyncService = new FileSyncService(config.autoSaveDelay);

    // Get extension URI from workspace folders or use a fallback
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders?.length) {
      this.extensionUri = workspaceFolders[0].uri;
    }

    if (this.isEnabled) {
      this.initialize(config.rootFolder);
    }

    // Watch for config changes
    this.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('httpyac.ui')) {
          this.onConfigChanged();
        }
      })
    );

    this.subscriptions.push(this.fileSyncService);
  }

  /**
   * Initialize the UI components
   */
  private async initialize(rootFolder?: string): Promise<void> {
    await this.fileSyncService.initialize(rootFolder);

    // Create tree provider
    this.collectionsTreeProvider = new CollectionsTreeProvider(this.fileSyncService);

    // Create request editor provider
    if (this.extensionUri) {
      this.requestEditorProvider = new RequestEditorProvider(
        this.extensionUri,
        this.documentStore,
        this.responseStore,
        this.fileSyncService
      );
      this.subscriptions.push(this.requestEditorProvider);
    }

    // Handle request selection
    this.collectionsTreeProvider.onRequestSelected(request => {
      this.openRequestEditor(request);
    });

    // Listen for response changes to update request status
    this.responseStore.historyChanged(() => {
      this.updateRequestStatuses();
    });

    // Listen for httpRegion execution events
    this.documentStore.httpRegionExecuted(event => {
      if (event.httpRegion.response) {
        const status = event.httpRegion.response.statusCode < 400 ? 'success' : 'error';
        const fileUri = event.httpFile.fileName;
        if (typeof fileUri === 'object' && 'fsPath' in fileUri) {
          this.collectionsTreeProvider?.updateRequestStatus(fileUri as vscode.Uri, status);
        }
      }
    });

    this.subscriptions.push(this.collectionsTreeProvider);

    // Refresh collections now that tree provider is subscribed
    // This ensures existing collections are loaded on startup
    await this.fileSyncService.refreshCollections();
  }

  /**
   * Handle configuration changes
   */
  private async onConfigChanged(): Promise<void> {
    const config = getUIConfig();

    if (config.enabled && !this.isEnabled) {
      // Enable UI
      this.isEnabled = true;
      await this.initialize(config.rootFolder);
    } else if (!config.enabled && this.isEnabled) {
      // Disable UI
      this.isEnabled = false;
      this.collectionsTreeProvider?.dispose();
      this.collectionsTreeProvider = undefined;
    }
  }

  /**
   * Open the request editor for a request
   */
  private async openRequestEditor(request: UIRequest): Promise<void> {
    if (this.requestEditorProvider) {
      await this.requestEditorProvider.showRequest(request);
    } else if (request.fileUri) {
      // Fallback: open the file in the text editor
      const doc = await vscode.workspace.openTextDocument(request.fileUri);
      await vscode.window.showTextDocument(doc, {
        preview: true,
        viewColumn: vscode.ViewColumn.One,
      });
    }
  }

  /**
   * Update request statuses based on response history
   */
  private updateRequestStatuses(): void {
    if (!this.collectionsTreeProvider) return;

    for (const responseItem of this.responseStore.responseCache) {
      if (responseItem.documentUri) {
        const status = responseItem.response.statusCode < 400 ? 'success' : 'error';
        this.collectionsTreeProvider.updateRequestStatus(responseItem.documentUri, status);
      }
    }
  }

  /**
   * Get the file sync service
   */
  getFileSyncService(): FileSyncService {
    return this.fileSyncService;
  }

  /**
   * Get the collections tree provider
   */
  getCollectionsTreeProvider(): CollectionsTreeProvider | undefined {
    return this.collectionsTreeProvider;
  }
}

