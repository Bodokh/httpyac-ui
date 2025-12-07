import * as vscode from 'vscode';
import { CollectionTreeNode, HttpMethod } from '../types';

/**
 * Get the icon for an HTTP method
 */
function getMethodIcon(method: HttpMethod): vscode.ThemeIcon {
  const iconMap: Record<HttpMethod, { id: string; color: string }> = {
    GET: { id: 'arrow-down', color: 'charts.green' },
    POST: { id: 'arrow-up', color: 'charts.yellow' },
    PUT: { id: 'arrow-swap', color: 'charts.blue' },
    DELETE: { id: 'trash', color: 'charts.red' },
    PATCH: { id: 'edit', color: 'charts.purple' },
    HEAD: { id: 'eye', color: 'charts.gray' },
    OPTIONS: { id: 'settings', color: 'charts.gray' },
    CONNECT: { id: 'plug', color: 'charts.gray' },
    TRACE: { id: 'debug-step-into', color: 'charts.gray' },
  };

  const config = iconMap[method] || { id: 'circle-outline', color: 'charts.gray' };
  return new vscode.ThemeIcon(config.id, new vscode.ThemeColor(config.color));
}

/**
 * Get status icon based on last run status
 */
function getStatusDecoration(node: CollectionTreeNode): string {
  switch (node.lastRunStatus) {
    case 'success':
      return '✓';
    case 'error':
      return '✗';
    case 'pending':
      return '⋯';
    default:
      return '';
  }
}

/**
 * Tree item for collections panel
 */
export class CollectionTreeItem extends vscode.TreeItem {
  constructor(
    public readonly node: CollectionTreeNode,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(node.label, collapsibleState);

    this.id = node.id;
    this.tooltip = this.createTooltip();
    this.contextValue = node.type;
    this.resourceUri = vscode.Uri.file(node.filePath);

    if (node.type === 'request') {
      this.setupRequestItem();
    } else {
      this.setupCollectionItem();
    }
  }

  private setupRequestItem(): void {
    // Set method badge
    if (this.node.method) {
      this.iconPath = getMethodIcon(this.node.method);
      this.description = this.node.method;
    }

    // Add status decoration
    const status = getStatusDecoration(this.node);
    if (status) {
      this.description = `${this.node.method || ''} ${status}`.trim();
    }

    // Command to open request in editor
    this.command = {
      title: 'Open Request',
      command: 'httpyac.ui.openRequest',
      arguments: [this.node],
    };
  }

  private setupCollectionItem(): void {
    this.iconPath = new vscode.ThemeIcon('folder');

    // Show test results if available
    if (this.node.testsPassed !== undefined || this.node.testsFailed !== undefined) {
      const passed = this.node.testsPassed || 0;
      const failed = this.node.testsFailed || 0;
      this.description = `${passed}/${passed + failed} tests`;
    }
  }

  private createTooltip(): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.supportThemeIcons = true;

    md.appendMarkdown(`**${this.node.label}**\n\n`);

    if (this.node.description) {
      md.appendMarkdown(`${this.node.description}\n\n`);
    }

    if (this.node.type === 'request' && this.node.method) {
      md.appendMarkdown(`Method: \`${this.node.method}\`\n\n`);
    }

    md.appendMarkdown(`Path: \`${this.node.filePath}\``);

    return md;
  }
}

