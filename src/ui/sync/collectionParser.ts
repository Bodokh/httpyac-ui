import * as vscode from 'vscode';
import * as httpyac from 'httpyac';
import * as path from 'path';
import {
  CollectionTreeNode,
  CollectionMetadata,
  UIRequest,
  HttpMethod,
  RequestHeader,
  QueryParam,
  RequestBody,
  CollectionsManifest,
} from '../types';

const COLLECTION_METADATA_FILE = '_collection.json';
const COLLECTIONS_MANIFEST_FILE = 'collections.json';
const HTTP_EXTENSIONS = ['.http', '.rest'];

/**
 * Parses collection structure from disk
 */
export class CollectionParser {
  constructor(private readonly rootUri: vscode.Uri) {}

  /**
   * Parse the entire collection tree from the root folder
   */
  async parseCollectionTree(): Promise<CollectionTreeNode[]> {
    const collections: CollectionTreeNode[] = [];

    try {
      const entries = await vscode.workspace.fs.readDirectory(this.rootUri);

      for (const [name, type] of entries) {
        if (type === vscode.FileType.Directory && !name.startsWith('.') && name !== 'environments') {
          const folderUri = vscode.Uri.joinPath(this.rootUri, name);
          const node = await this.parseFolder(folderUri, name);
          if (node) {
            collections.push(node);
          }
        }
      }

      // Sort by manifest order if available
      const manifest = await this.loadManifest();
      if (manifest?.collections?.length) {
        collections.sort((a, b) => {
          const indexA = manifest.collections.indexOf(a.label);
          const indexB = manifest.collections.indexOf(b.label);
          if (indexA === -1 && indexB === -1) return 0;
          if (indexA === -1) return 1;
          if (indexB === -1) return -1;
          return indexA - indexB;
        });
      }
    } catch (err) {
      httpyac.io.log.error('Failed to parse collection tree', err);
    }

    return collections;
  }

  /**
   * Parse a folder as a collection or sub-folder
   */
  private async parseFolder(folderUri: vscode.Uri, name: string): Promise<CollectionTreeNode | undefined> {
    const metadata = await this.loadCollectionMetadata(folderUri);
    const children: CollectionTreeNode[] = [];

    try {
      const entries = await vscode.workspace.fs.readDirectory(folderUri);

      // Parse sub-folders first
      for (const [entryName, type] of entries) {
        if (type === vscode.FileType.Directory && !entryName.startsWith('.') && !entryName.startsWith('_')) {
          const subFolderUri = vscode.Uri.joinPath(folderUri, entryName);
          const subNode = await this.parseFolder(subFolderUri, entryName);
          if (subNode) {
            children.push(subNode);
          }
        }
      }

      // Parse HTTP files
      for (const [entryName, type] of entries) {
        if (type === vscode.FileType.File && HTTP_EXTENSIONS.some(ext => entryName.endsWith(ext))) {
          const fileUri = vscode.Uri.joinPath(folderUri, entryName);
          const requestNode = await this.parseHttpFile(fileUri, entryName);
          if (requestNode) {
            children.push(requestNode);
          }
        }
      }

      // Sort children by metadata order
      if (metadata?.order?.length) {
        children.sort((a, b) => {
          const indexA = metadata.order!.indexOf(a.label);
          const indexB = metadata.order!.indexOf(b.label);
          if (indexA === -1 && indexB === -1) return 0;
          if (indexA === -1) return 1;
          if (indexB === -1) return -1;
          return indexA - indexB;
        });
      }
    } catch (err) {
      httpyac.io.log.error(`Failed to parse folder ${folderUri.toString()}`, err);
    }

    return {
      type: 'collection',
      id: folderUri.toString(),
      label: metadata?.name || name,
      description: metadata?.description,
      filePath: folderUri.fsPath,
      folderPath: folderUri.fsPath,
      children,
    };
  }

  /**
   * Parse an HTTP file as a request node
   */
  private async parseHttpFile(fileUri: vscode.Uri, fileName: string): Promise<CollectionTreeNode | undefined> {
    try {
      const content = await vscode.workspace.fs.readFile(fileUri);
      const text = Buffer.from(content).toString('utf-8');

      // Extract metadata from comments
      const nameMatch = text.match(/^#\s*@name\s+(.+)$/m);
      const descriptionMatch = text.match(/^#\s*@description\s+(.+)$/m);
      const methodMatch = text.match(/^\s*(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|CONNECT|TRACE)\s+/m);

      const name = nameMatch?.[1]?.trim() || path.basename(fileName, path.extname(fileName));
      const method = (methodMatch?.[1] as HttpMethod) || 'GET';

      return {
        type: 'request',
        id: fileUri.toString(),
        label: name,
        description: descriptionMatch?.[1]?.trim(),
        method,
        filePath: fileUri.fsPath,
        folderPath: path.dirname(fileUri.fsPath),
        lastRunStatus: 'none',
      };
    } catch (err) {
      httpyac.io.log.error(`Failed to parse HTTP file ${fileUri.toString()}`, err);
      return undefined;
    }
  }

  /**
   * Load collection metadata from _collection.json
   */
  private async loadCollectionMetadata(folderUri: vscode.Uri): Promise<CollectionMetadata | undefined> {
    try {
      const metadataUri = vscode.Uri.joinPath(folderUri, COLLECTION_METADATA_FILE);
      const content = await vscode.workspace.fs.readFile(metadataUri);
      return JSON.parse(Buffer.from(content).toString('utf-8'));
    } catch {
      return undefined;
    }
  }

  /**
   * Load the root collections manifest
   */
  async loadManifest(): Promise<CollectionsManifest | undefined> {
    try {
      const manifestUri = vscode.Uri.joinPath(this.rootUri, COLLECTIONS_MANIFEST_FILE);
      const content = await vscode.workspace.fs.readFile(manifestUri);
      return JSON.parse(Buffer.from(content).toString('utf-8'));
    } catch {
      return undefined;
    }
  }

  /**
   * Parse an HTTP file into a UIRequest object
   */
  async parseHttpFileToRequest(fileUri: vscode.Uri): Promise<UIRequest | undefined> {
    try {
      const content = await vscode.workspace.fs.readFile(fileUri);
      const text = Buffer.from(content).toString('utf-8');

      return this.parseHttpText(text, fileUri);
    } catch (err) {
      httpyac.io.log.error(`Failed to parse HTTP file to request ${fileUri.toString()}`, err);
      return undefined;
    }
  }

  /**
   * Parse HTTP text content into a UIRequest
   */
  parseHttpText(text: string, fileUri?: vscode.Uri): UIRequest {
    const lines = text.split('\n');
    const request: UIRequest = {
      id: fileUri?.toString() || `request-${Date.now()}`,
      name: 'New Request',
      method: 'GET',
      url: '',
      headers: [],
      queryParams: [],
      body: { type: 'none' },
      fileUri,
    };

    let inBody = false;
    let bodyLines: string[] = [];
    let inScript = false;
    let scriptType: 'pre' | 'test' | null = null;
    let scriptLines: string[] = [];

    for (const line of lines) {
      const trimmedLine = line.trim();

      // Skip separators
      if (trimmedLine === '###') continue;

      // Parse metadata comments
      if (trimmedLine.startsWith('# @name ')) {
        request.name = trimmedLine.slice(8).trim();
        continue;
      }
      if (trimmedLine.startsWith('# @description ')) {
        request.description = trimmedLine.slice(15).trim();
        continue;
      }
      if (trimmedLine.startsWith('# @tag ')) {
        request.tags = trimmedLine
          .slice(7)
          .split(',')
          .map(t => t.trim());
        continue;
      }

      // Handle script blocks
      if (trimmedLine.startsWith('{{')) {
        inScript = true;
        if (trimmedLine.includes('@pre')) {
          scriptType = 'pre';
        } else {
          scriptType = 'test';
        }
        continue;
      }
      if (trimmedLine.startsWith('}}')) {
        if (scriptType === 'pre') {
          request.preRequest = scriptLines.join('\n');
        } else if (scriptType === 'test') {
          request.tests = scriptLines.join('\n');
        }
        inScript = false;
        scriptType = null;
        scriptLines = [];
        continue;
      }
      if (inScript) {
        scriptLines.push(line);
        continue;
      }

      // Skip other comments
      if (trimmedLine.startsWith('#') || trimmedLine.startsWith('//')) continue;

      // Parse request line
      const requestLineMatch = trimmedLine.match(
        /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|CONNECT|TRACE)\s+(.+)$/i
      );
      if (requestLineMatch) {
        request.method = requestLineMatch[1].toUpperCase() as HttpMethod;
        const fullUrl = requestLineMatch[2].trim();

        // Parse URL and query params
        const [baseUrl, queryString] = fullUrl.split('?');
        request.url = baseUrl;

        if (queryString) {
          const params = new URLSearchParams(queryString);
          params.forEach((value, key) => {
            request.queryParams.push({ key, value, enabled: true });
          });
        }
        continue;
      }

      // Detect body start (empty line after headers)
      if (!inBody && trimmedLine === '' && request.url) {
        inBody = true;
        continue;
      }

      // Parse headers (before body)
      if (!inBody && trimmedLine.includes(':')) {
        const colonIndex = trimmedLine.indexOf(':');
        const key = trimmedLine.slice(0, colonIndex).trim();
        const value = trimmedLine.slice(colonIndex + 1).trim();

        if (key && !key.startsWith('{')) {
          request.headers.push({ key, value, enabled: true });
        }
        continue;
      }

      // Collect body lines
      if (inBody) {
        bodyLines.push(line);
      }
    }

    // Process body
    if (bodyLines.length > 0) {
      const bodyText = bodyLines.join('\n').trim();
      if (bodyText) {
        request.body = this.detectBodyType(bodyText, request.headers);
      }
    }

    return request;
  }

  /**
   * Detect the type of request body
   */
  private detectBodyType(body: string, headers: RequestHeader[]): RequestBody {
    const contentType = headers.find(h => h.key.toLowerCase() === 'content-type')?.value?.toLowerCase() || '';

    if (contentType.includes('application/json') || body.trim().startsWith('{') || body.trim().startsWith('[')) {
      return { type: 'json', content: body };
    }
    if (contentType.includes('application/x-www-form-urlencoded')) {
      return { type: 'form', content: body };
    }
    if (contentType.includes('multipart/form-data')) {
      return { type: 'formdata', content: body };
    }
    if (contentType.includes('application/graphql') || body.includes('query') || body.includes('mutation')) {
      return {
        type: 'graphql',
        graphql: { query: body },
      };
    }

    return { type: 'raw', content: body };
  }
}

