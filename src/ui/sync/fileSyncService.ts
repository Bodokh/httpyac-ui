import * as vscode from 'vscode';
import * as httpyac from 'httpyac';
import * as path from 'path';
import { DisposeProvider } from '../../utils';
import { CollectionTreeNode, CollectionMetadata, UIRequest, CollectionsManifest, Environment } from '../types';
import { CollectionParser } from './collectionParser';
import { httpGenerator } from './httpGenerator';

const COLLECTION_METADATA_FILE = '_collection.json';
const COLLECTIONS_MANIFEST_FILE = 'collections.json';
const ENVIRONMENTS_FOLDER = 'environments';
const DEFAULT_ROOT_FOLDER = '.rest';

/**
 * Service for two-way synchronization between UI and file system
 */
export class FileSyncService extends DisposeProvider {
  private watcher: vscode.FileSystemWatcher | undefined;
  private parser: CollectionParser | undefined;
  private writeDebounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private pendingWrites: Set<string> = new Set();

  private readonly _onCollectionsChanged = new vscode.EventEmitter<CollectionTreeNode[]>();
  readonly onCollectionsChanged = this._onCollectionsChanged.event;

  private readonly _onEnvironmentsChanged = new vscode.EventEmitter<Environment[]>();
  readonly onEnvironmentsChanged = this._onEnvironmentsChanged.event;

  private readonly _onRequestChanged = new vscode.EventEmitter<{ uri: vscode.Uri; request: UIRequest }>();
  readonly onRequestChanged = this._onRequestChanged.event;

  private _rootUri: vscode.Uri | undefined;
  private _isInitialized = false;

  constructor(private readonly debounceDelay: number = 300) {
    super();
    this.subscriptions = [this._onCollectionsChanged, this._onEnvironmentsChanged, this._onRequestChanged];
  }

  /**
   * Get the root URI for collections
   */
  get rootUri(): vscode.Uri | undefined {
    return this._rootUri;
  }

  /**
   * Check if service is initialized
   */
  get isInitialized(): boolean {
    return this._isInitialized;
  }

  /**
   * Initialize the sync service
   */
  async initialize(rootFolder?: string): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders?.length) {
      httpyac.io.log.warn('No workspace folder found for FileSyncService');
      return;
    }

    const workspaceRoot = workspaceFolders[0].uri;
    const folderName = rootFolder || DEFAULT_ROOT_FOLDER;
    this._rootUri = vscode.Uri.joinPath(workspaceRoot, folderName);
    this.parser = new CollectionParser(this._rootUri);

    // Ensure root folder exists
    await this.ensureRootFolder();

    // Start watching for changes
    this.startWatching();

    this._isInitialized = true;
    httpyac.io.log.info(`FileSyncService initialized at ${this._rootUri.fsPath}`);

    // Initial load
    await this.refreshCollections();
    await this.refreshEnvironments();
  }

  /**
   * Ensure the root folder exists with proper structure
   */
  private async ensureRootFolder(): Promise<void> {
    if (!this._rootUri) return;

    try {
      await vscode.workspace.fs.stat(this._rootUri);
    } catch {
      // Create root folder
      await vscode.workspace.fs.createDirectory(this._rootUri);

      // Create environments folder
      const envsUri = vscode.Uri.joinPath(this._rootUri, ENVIRONMENTS_FOLDER);
      await vscode.workspace.fs.createDirectory(envsUri);

      // Create default manifest
      await this.saveManifest({
        version: '1.0.0',
        collections: [],
        lastModified: new Date().toISOString(),
      });

      httpyac.io.log.info(`Created REST collections folder at ${this._rootUri.fsPath}`);
    }
  }

  /**
   * Start watching for file changes
   */
  private startWatching(): void {
    if (!this._rootUri) return;

    this.watcher?.dispose();

    const pattern = new vscode.RelativePattern(this._rootUri, '**/*.{http,rest,json,env}');
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

    this.watcher.onDidCreate(uri => this.onFileCreated(uri));
    this.watcher.onDidChange(uri => this.onFileChanged(uri));
    this.watcher.onDidDelete(uri => this.onFileDeleted(uri));

    this.subscriptions.push(this.watcher);
  }

  /**
   * Handle file creation
   */
  private async onFileCreated(uri: vscode.Uri): Promise<void> {
    // Ignore our own writes
    if (this.pendingWrites.has(uri.toString())) {
      return;
    }

    httpyac.io.log.debug(`File created: ${uri.fsPath}`);

    if (this.isEnvironmentFile(uri)) {
      await this.refreshEnvironments();
    } else {
      await this.refreshCollections();
    }
  }

  /**
   * Handle file changes
   */
  private async onFileChanged(uri: vscode.Uri): Promise<void> {
    // Ignore our own writes
    if (this.pendingWrites.has(uri.toString())) {
      return;
    }

    httpyac.io.log.debug(`File changed: ${uri.fsPath}`);

    if (this.isEnvironmentFile(uri)) {
      await this.refreshEnvironments();
    } else if (this.isHttpFile(uri)) {
      const request = await this.parser?.parseHttpFileToRequest(uri);
      if (request) {
        this._onRequestChanged.fire({ uri, request });
      }
    } else {
      await this.refreshCollections();
    }
  }

  /**
   * Handle file deletion
   */
  private async onFileDeleted(uri: vscode.Uri): Promise<void> {
    httpyac.io.log.debug(`File deleted: ${uri.fsPath}`);

    if (this.isEnvironmentFile(uri)) {
      await this.refreshEnvironments();
    } else {
      await this.refreshCollections();
    }
  }

  /**
   * Check if URI is an HTTP file
   */
  private isHttpFile(uri: vscode.Uri): boolean {
    return uri.fsPath.endsWith('.http') || uri.fsPath.endsWith('.rest');
  }

  /**
   * Check if URI is an environment file
   */
  private isEnvironmentFile(uri: vscode.Uri): boolean {
    return uri.fsPath.includes(ENVIRONMENTS_FOLDER) && uri.fsPath.endsWith('.env');
  }

  /**
   * Refresh and emit collections tree
   */
  async refreshCollections(): Promise<CollectionTreeNode[]> {
    if (!this.parser) return [];

    const collections = await this.parser.parseCollectionTree();
    this._onCollectionsChanged.fire(collections);
    return collections;
  }

  /**
   * Refresh and emit environments
   */
  async refreshEnvironments(): Promise<Environment[]> {
    if (!this._rootUri) return [];

    const environments: Environment[] = [];
    const envsUri = vscode.Uri.joinPath(this._rootUri, ENVIRONMENTS_FOLDER);

    try {
      const entries = await vscode.workspace.fs.readDirectory(envsUri);

      for (const [name, type] of entries) {
        if (type === vscode.FileType.File && name.endsWith('.env')) {
          const envUri = vscode.Uri.joinPath(envsUri, name);
          const env = await this.loadEnvironment(envUri);
          if (env) {
            environments.push(env);
          }
        }
      }
    } catch {
      // Environments folder may not exist yet
    }

    this._onEnvironmentsChanged.fire(environments);
    return environments;
  }

  /**
   * Load an environment file
   */
  private async loadEnvironment(uri: vscode.Uri): Promise<Environment | undefined> {
    try {
      const content = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(content).toString('utf-8');
      const variables: Record<string, string> = {};

      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const eqIndex = trimmed.indexOf('=');
          if (eqIndex > 0) {
            const key = trimmed.slice(0, eqIndex).trim();
            const value = trimmed.slice(eqIndex + 1).trim();
            variables[key] = value;
          }
        }
      }

      return {
        name: path.basename(uri.fsPath, '.env'),
        variables,
        filePath: uri.fsPath,
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Get a request by URI
   */
  async getRequest(uri: vscode.Uri): Promise<UIRequest | undefined> {
    return this.parser?.parseHttpFileToRequest(uri);
  }

  /**
   * Save a request to disk (debounced)
   */
  async saveRequest(request: UIRequest, immediate = false): Promise<void> {
    if (!request.fileUri) {
      throw new Error('Request has no file URI');
    }

    // Ensure we have a proper URI (might be serialized from webview)
    const fileUri = this.ensureUri(request.fileUri);
    const uriString = fileUri.toString();

    // Update the request with the proper URI
    request.fileUri = fileUri;

    // Clear existing timer
    const existingTimer = this.writeDebounceTimers.get(uriString);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    if (immediate) {
      await this.writeRequest(request);
    } else {
      // Debounce writes
      const timer = setTimeout(() => {
        this.writeRequest(request);
        this.writeDebounceTimers.delete(uriString);
      }, this.debounceDelay);

      this.writeDebounceTimers.set(uriString, timer);
    }
  }

  /**
   * Write request to disk
   */
  private async writeRequest(request: UIRequest): Promise<void> {
    if (!request.fileUri) return;

    const content = httpGenerator.generate(request);

    // Ensure we have a proper vscode.Uri (might be a plain object from webview serialization)
    const fileUri = this.ensureUri(request.fileUri);
    const uriString = fileUri.toString();

    // Mark as pending to ignore our own file change event
    this.pendingWrites.add(uriString);

    try {
      await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(content));
      httpyac.io.log.debug(`Saved request to ${fileUri.fsPath}`);
    } finally {
      // Remove from pending after a short delay to ensure the event is ignored
      setTimeout(() => {
        this.pendingWrites.delete(uriString);
      }, 100);
    }
  }

  /**
   * Ensure a URI-like object is a proper vscode.Uri
   * (handles objects that were serialized/deserialized through webview)
   */
  private ensureUri(uri: vscode.Uri | { scheme?: string; path?: string; fsPath?: string }): vscode.Uri {
    // If it's already a proper Uri with methods, return it
    if (uri && typeof (uri as vscode.Uri).with === 'function') {
      return uri as vscode.Uri;
    }

    // Reconstruct from fsPath or path
    const fsPath = (uri as { fsPath?: string }).fsPath || (uri as { path?: string }).path;
    if (fsPath) {
      return vscode.Uri.file(fsPath);
    }

    // Try to parse from toString if available
    const uriString = uri?.toString?.();
    if (uriString && uriString.startsWith('file://')) {
      return vscode.Uri.parse(uriString);
    }

    throw new Error('Invalid URI object');
  }

  /**
   * Create a new collection
   */
  async createCollection(name: string, parentPath?: string): Promise<vscode.Uri | undefined> {
    if (!this._rootUri) return undefined;

    const parentUri = parentPath ? vscode.Uri.file(parentPath) : this._rootUri;
    const collectionUri = vscode.Uri.joinPath(parentUri, name);

    try {
      await vscode.workspace.fs.createDirectory(collectionUri);

      // Create metadata file
      const metadata: CollectionMetadata = {
        name,
        created: new Date().toISOString(),
        modified: new Date().toISOString(),
      };

      const metadataUri = vscode.Uri.joinPath(collectionUri, COLLECTION_METADATA_FILE);
      await vscode.workspace.fs.writeFile(metadataUri, new TextEncoder().encode(JSON.stringify(metadata, null, 2)));

      await this.refreshCollections();
      return collectionUri;
    } catch (err) {
      httpyac.io.log.error(`Failed to create collection ${name}`, err);
      return undefined;
    }
  }

  /**
   * Create a new request
   */
  async createRequest(name: string, collectionPath: string): Promise<UIRequest | undefined> {
    const fileName = this.sanitizeFileName(name) + '.http';
    const fileUri = vscode.Uri.joinPath(vscode.Uri.file(collectionPath), fileName);

    const request: UIRequest = {
      id: fileUri.toString(),
      name,
      method: 'GET',
      url: 'https://api.example.com/endpoint',
      headers: [{ key: 'Accept', value: 'application/json', enabled: true }],
      queryParams: [],
      body: { type: 'none' },
      fileUri,
      collectionPath,
    };

    await this.writeRequest(request);
    await this.refreshCollections();

    return request;
  }

  /**
   * Delete a request file
   */
  async deleteRequest(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.delete(uri);
      await this.refreshCollections();
      return true;
    } catch (err) {
      httpyac.io.log.error(`Failed to delete request ${uri.fsPath}`, err);
      return false;
    }
  }

  /**
   * Delete a collection folder
   */
  async deleteCollection(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.delete(uri, { recursive: true });
      await this.refreshCollections();
      return true;
    } catch (err) {
      httpyac.io.log.error(`Failed to delete collection ${uri.fsPath}`, err);
      return false;
    }
  }

  /**
   * Rename an item (request or collection)
   */
  async renameItem(uri: vscode.Uri, newName: string, isCollection: boolean): Promise<vscode.Uri | undefined> {
    try {
      const parentUri = vscode.Uri.joinPath(uri, '..');
      let newUri: vscode.Uri;

      if (isCollection) {
        newUri = vscode.Uri.joinPath(parentUri, newName);
      } else {
        const ext = path.extname(uri.fsPath);
        newUri = vscode.Uri.joinPath(parentUri, this.sanitizeFileName(newName) + ext);
      }

      await vscode.workspace.fs.rename(uri, newUri);
      await this.refreshCollections();

      return newUri;
    } catch (err) {
      httpyac.io.log.error(`Failed to rename ${uri.fsPath} to ${newName}`, err);
      return undefined;
    }
  }

  /**
   * Duplicate a request
   */
  async duplicateRequest(uri: vscode.Uri): Promise<UIRequest | undefined> {
    const request = await this.getRequest(uri);
    if (!request) return undefined;

    const parentPath = path.dirname(uri.fsPath);
    const baseName = path.basename(uri.fsPath, path.extname(uri.fsPath));
    const newName = `${baseName}-copy`;

    return this.createRequest(newName, parentPath);
  }

  /**
   * Save collection metadata
   */
  async saveCollectionMetadata(collectionPath: string, metadata: CollectionMetadata): Promise<void> {
    const metadataUri = vscode.Uri.joinPath(vscode.Uri.file(collectionPath), COLLECTION_METADATA_FILE);

    const updated: CollectionMetadata = {
      ...metadata,
      modified: new Date().toISOString(),
    };

    await vscode.workspace.fs.writeFile(metadataUri, new TextEncoder().encode(JSON.stringify(updated, null, 2)));
  }

  /**
   * Save the root collections manifest
   */
  async saveManifest(manifest: CollectionsManifest): Promise<void> {
    if (!this._rootUri) return;

    const manifestUri = vscode.Uri.joinPath(this._rootUri, COLLECTIONS_MANIFEST_FILE);
    await vscode.workspace.fs.writeFile(manifestUri, new TextEncoder().encode(JSON.stringify(manifest, null, 2)));
  }

  /**
   * Save environment file
   */
  async saveEnvironment(env: Environment): Promise<void> {
    if (!this._rootUri) return;

    const envUri = vscode.Uri.joinPath(this._rootUri, ENVIRONMENTS_FOLDER, `${env.name}.env`);
    const lines = Object.entries(env.variables).map(([key, value]) => `${key}=${value}`);

    await vscode.workspace.fs.writeFile(envUri, new TextEncoder().encode(lines.join('\n')));
    await this.refreshEnvironments();
  }

  /**
   * Sanitize a name for use as a file name
   */
  private sanitizeFileName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    for (const timer of this.writeDebounceTimers.values()) {
      clearTimeout(timer);
    }
    this.writeDebounceTimers.clear();
    super.dispose();
  }
}
