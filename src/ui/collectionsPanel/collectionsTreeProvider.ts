import * as vscode from 'vscode';
import { DisposeProvider } from '../../utils';
import { CollectionTreeNode, UIRequest } from '../types';
import { FileSyncService } from '../sync';
import { ImportExportService } from '../import';
import { CollectionTreeItem } from './collectionTreeItem';
import { commands } from './commands';

/**
 * Tree data provider for the collections panel
 */
export class CollectionsTreeProvider extends DisposeProvider implements vscode.TreeDataProvider<CollectionTreeNode> {
  private collections: CollectionTreeNode[] = [];
  private importExportService: ImportExportService;

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<CollectionTreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly _onRequestSelected = new vscode.EventEmitter<UIRequest>();
  readonly onRequestSelected = this._onRequestSelected.event;

  constructor(private readonly fileSyncService: FileSyncService) {
    super();

    this.importExportService = new ImportExportService(fileSyncService);

    // Subscribe to collection changes
    fileSyncService.onCollectionsChanged(collections => {
      this.collections = collections;
      this._onDidChangeTreeData.fire(undefined);
    });

    this.subscriptions = [
      this._onDidChangeTreeData,
      this._onRequestSelected,
      vscode.window.registerTreeDataProvider('httpyacCollections', this),
      ...this.registerCommands(),
    ];
  }

  /**
   * Register all commands for the collections panel
   */
  private registerCommands(): vscode.Disposable[] {
    return [
      vscode.commands.registerCommand(commands.openRequest, async (node: CollectionTreeNode) => {
        await this.openRequest(node);
      }),

      vscode.commands.registerCommand(commands.newRequest, async (node?: CollectionTreeNode) => {
        await this.createNewRequest(node);
      }),

      vscode.commands.registerCommand(commands.newCollection, async (node?: CollectionTreeNode) => {
        await this.createNewCollection(node);
      }),

      vscode.commands.registerCommand(commands.deleteItem, async (node: CollectionTreeNode) => {
        await this.deleteItem(node);
      }),

      vscode.commands.registerCommand(commands.renameItem, async (node: CollectionTreeNode) => {
        await this.renameItem(node);
      }),

      vscode.commands.registerCommand(commands.duplicateRequest, async (node: CollectionTreeNode) => {
        await this.duplicateRequest(node);
      }),

      vscode.commands.registerCommand(commands.refreshCollections, async () => {
        await this.refresh();
      }),

      vscode.commands.registerCommand(commands.sendRequest, async (node: CollectionTreeNode) => {
        await this.sendRequest(node);
      }),

      vscode.commands.registerCommand(commands.openInEditor, async (node: CollectionTreeNode) => {
        await this.openInEditor(node);
      }),

      vscode.commands.registerCommand(commands.importCollection, async () => {
        await this.importExportService.importCollection();
      }),

      vscode.commands.registerCommand(commands.exportCollection, async (node: CollectionTreeNode) => {
        await this.importExportService.exportCollection(node);
      }),
    ];
  }

  /**
   * Get tree item for a node
   */
  getTreeItem(element: CollectionTreeNode): vscode.TreeItem {
    const hasChildren = element.children && element.children.length > 0;
    const collapsibleState = hasChildren
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;

    return new CollectionTreeItem(element, collapsibleState);
  }

  /**
   * Get children of a node
   */
  getChildren(element?: CollectionTreeNode): CollectionTreeNode[] {
    if (!element) {
      return this.collections;
    }
    return element.children || [];
  }

  /**
   * Get parent of a node
   */
  getParent(element: CollectionTreeNode): CollectionTreeNode | undefined {
    return this.findParent(element, this.collections);
  }

  /**
   * Find parent of a node recursively
   */
  private findParent(
    target: CollectionTreeNode,
    nodes: CollectionTreeNode[],
    parent?: CollectionTreeNode
  ): CollectionTreeNode | undefined {
    for (const node of nodes) {
      if (node.id === target.id) {
        return parent;
      }
      if (node.children) {
        const found = this.findParent(target, node.children, node);
        if (found) return found;
      }
    }
    return undefined;
  }

  /**
   * Refresh the tree
   */
  async refresh(): Promise<void> {
    await this.fileSyncService.refreshCollections();
  }

  /**
   * Open a request in the editor panel
   */
  private async openRequest(node: CollectionTreeNode): Promise<void> {
    if (node.type !== 'request') return;

    const request = await this.fileSyncService.getRequest(vscode.Uri.file(node.filePath));
    if (request) {
      this._onRequestSelected.fire(request);
    }
  }

  /**
   * Create a new request
   */
  private async createNewRequest(node?: CollectionTreeNode): Promise<void> {
    const name = await vscode.window.showInputBox({
      prompt: 'Enter request name',
      placeHolder: 'My Request',
      validateInput: value => {
        if (!value?.trim()) return 'Name cannot be empty';
        return undefined;
      },
    });

    if (!name) return;

    let collectionPath: string;
    if (node) {
      collectionPath = node.type === 'request' ? node.folderPath : node.filePath;
    } else if (this.fileSyncService.rootUri) {
      // Create in first collection or root
      if (this.collections.length > 0) {
        collectionPath = this.collections[0].filePath;
      } else {
        // Need to create a collection first
        const collection = await this.createNewCollection();
        if (!collection) return;
        collectionPath = collection;
      }
    } else {
      vscode.window.showErrorMessage('No workspace folder found');
      return;
    }

    const request = await this.fileSyncService.createRequest(name, collectionPath);
    if (request) {
      this._onRequestSelected.fire(request);
    }
  }

  /**
   * Create a new collection
   */
  private async createNewCollection(node?: CollectionTreeNode): Promise<string | undefined> {
    const name = await vscode.window.showInputBox({
      prompt: 'Enter collection name',
      placeHolder: 'My Collection',
      validateInput: value => {
        if (!value?.trim()) return 'Name cannot be empty';
        return undefined;
      },
    });

    if (!name) return;

    const parentPath = node
      ? node.type === 'request'
        ? node.folderPath
        : node.filePath
      : undefined;

    const uri = await this.fileSyncService.createCollection(name, parentPath);
    return uri?.fsPath;
  }

  /**
   * Delete an item
   */
  private async deleteItem(node: CollectionTreeNode): Promise<void> {
    const itemType = node.type === 'request' ? 'request' : 'collection';
    const confirm = await vscode.window.showWarningMessage(
      `Are you sure you want to delete the ${itemType} "${node.label}"?`,
      { modal: true },
      'Delete'
    );

    if (confirm !== 'Delete') return;

    const uri = vscode.Uri.file(node.filePath);
    if (node.type === 'request') {
      await this.fileSyncService.deleteRequest(uri);
    } else {
      await this.fileSyncService.deleteCollection(uri);
    }
  }

  /**
   * Rename an item
   */
  private async renameItem(node: CollectionTreeNode): Promise<void> {
    const newName = await vscode.window.showInputBox({
      prompt: `Enter new name for ${node.type}`,
      value: node.label,
      validateInput: value => {
        if (!value?.trim()) return 'Name cannot be empty';
        return undefined;
      },
    });

    if (!newName || newName === node.label) return;

    const uri = vscode.Uri.file(node.filePath);
    await this.fileSyncService.renameItem(uri, newName, node.type !== 'request');
  }

  /**
   * Duplicate a request
   */
  private async duplicateRequest(node: CollectionTreeNode): Promise<void> {
    if (node.type !== 'request') return;

    const uri = vscode.Uri.file(node.filePath);
    const request = await this.fileSyncService.duplicateRequest(uri);
    if (request) {
      this._onRequestSelected.fire(request);
    }
  }

  /**
   * Send a request
   */
  private async sendRequest(node: CollectionTreeNode): Promise<void> {
    if (node.type !== 'request') return;

    // Execute the httpyac send command on the file
    const uri = vscode.Uri.file(node.filePath);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
    await vscode.commands.executeCommand('httpyac.send');
  }

  /**
   * Open item in VS Code editor
   */
  private async openInEditor(node: CollectionTreeNode): Promise<void> {
    const uri = vscode.Uri.file(node.filePath);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
  }

  /**
   * Find a node by ID
   */
  findNodeById(id: string): CollectionTreeNode | undefined {
    return this.findNodeInTree(id, this.collections);
  }

  private findNodeInTree(id: string, nodes: CollectionTreeNode[]): CollectionTreeNode | undefined {
    for (const node of nodes) {
      if (node.id === id) return node;
      if (node.children) {
        const found = this.findNodeInTree(id, node.children);
        if (found) return found;
      }
    }
    return undefined;
  }

  /**
   * Update status of a request node
   */
  updateRequestStatus(fileUri: vscode.Uri, status: 'success' | 'error' | 'pending' | 'none'): void {
    const node = this.findNodeById(fileUri.toString());
    if (node && node.type === 'request') {
      node.lastRunStatus = status;
      this._onDidChangeTreeData.fire(node);
    }
  }
}

