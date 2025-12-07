import * as vscode from 'vscode';
import * as httpyac from 'httpyac';
import * as path from 'path';
import { FileSyncService } from '../sync';
import { UIRequest, HttpMethod, RequestHeader, QueryParam, RequestBody, CollectionTreeNode } from '../types';

/**
 * Postman Collection v2.1 types
 */
interface PostmanCollection {
  info: {
    name: string;
    description?: string;
    schema: string;
  };
  item: PostmanItem[];
  variable?: PostmanVariable[];
}

interface PostmanItem {
  name: string;
  description?: string;
  request?: PostmanRequest;
  item?: PostmanItem[];
}

interface PostmanRequest {
  method: string;
  header?: PostmanHeader[];
  url: PostmanUrl | string;
  body?: PostmanBody;
  auth?: PostmanAuth;
}

interface PostmanHeader {
  key: string;
  value: string;
  disabled?: boolean;
}

interface PostmanUrl {
  raw?: string;
  protocol?: string;
  host?: string[];
  path?: string[];
  query?: PostmanQuery[];
}

interface PostmanQuery {
  key: string;
  value: string;
  disabled?: boolean;
}

interface PostmanBody {
  mode: 'raw' | 'urlencoded' | 'formdata' | 'file' | 'graphql';
  raw?: string;
  urlencoded?: Array<{ key: string; value: string; disabled?: boolean }>;
  formdata?: Array<{ key: string; value: string; type?: string; disabled?: boolean }>;
  graphql?: {
    query: string;
    variables?: string;
  };
  options?: {
    raw?: {
      language?: string;
    };
  };
}

interface PostmanAuth {
  type: string;
  bearer?: Array<{ key: string; value: string }>;
  basic?: Array<{ key: string; value: string }>;
}

interface PostmanVariable {
  key: string;
  value: string;
}

/**
 * OpenAPI/Swagger types (simplified)
 */
interface OpenAPISpec {
  openapi?: string;
  swagger?: string;
  info: {
    title: string;
    description?: string;
    version: string;
  };
  servers?: Array<{ url: string; description?: string }>;
  paths: Record<string, Record<string, OpenAPIOperation>>;
}

interface OpenAPIOperation {
  summary?: string;
  description?: string;
  operationId?: string;
  tags?: string[];
  parameters?: OpenAPIParameter[];
  requestBody?: {
    content?: Record<string, { schema?: unknown }>;
  };
}

interface OpenAPIParameter {
  name: string;
  in: 'query' | 'header' | 'path' | 'cookie';
  required?: boolean;
  schema?: { type?: string; default?: unknown };
}

/**
 * Service for importing and exporting collections
 */
export class ImportExportService {
  constructor(private readonly fileSyncService: FileSyncService) {}

  /**
   * Import a collection from a file
   */
  async importCollection(): Promise<void> {
    const fileUri = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Import',
      filters: {
        'Postman Collection': ['json'],
        'OpenAPI Spec': ['json', 'yaml', 'yml'],
        'cURL': ['txt', 'sh'],
        'All Files': ['*'],
      },
    });

    if (!fileUri?.[0]) return;

    try {
      const content = await vscode.workspace.fs.readFile(fileUri[0]);
      const text = Buffer.from(content).toString('utf-8');

      // Detect format
      const format = this.detectFormat(text, fileUri[0].fsPath);

      switch (format) {
        case 'postman':
          await this.importPostman(text);
          break;
        case 'openapi':
          await this.importOpenAPI(text);
          break;
        case 'curl':
          await this.importCurl(text);
          break;
        default:
          vscode.window.showErrorMessage('Unknown file format. Supported: Postman, OpenAPI, cURL');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to import collection: ${message}`);
    }
  }

  /**
   * Export a collection to a file
   */
  async exportCollection(node: CollectionTreeNode): Promise<void> {
    const format = await vscode.window.showQuickPick(
      [
        { label: 'Postman Collection v2.1', value: 'postman' },
        { label: 'HTTP File Archive (.har)', value: 'har' },
      ],
      { placeHolder: 'Select export format' }
    );

    if (!format) return;

    const defaultName = `${node.label}.${format.value === 'postman' ? 'postman_collection.json' : 'har'}`;
    const saveUri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(defaultName),
      filters:
        format.value === 'postman'
          ? { 'Postman Collection': ['json'] }
          : { 'HTTP Archive': ['har'] },
    });

    if (!saveUri) return;

    try {
      let content: string;

      switch (format.value) {
        case 'postman':
          content = await this.exportToPostman(node);
          break;
        case 'har':
          content = await this.exportToHAR(node);
          break;
        default:
          throw new Error('Unknown export format');
      }

      await vscode.workspace.fs.writeFile(saveUri, Buffer.from(content, 'utf-8'));
      vscode.window.showInformationMessage(`Collection exported to ${saveUri.fsPath}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to export collection: ${message}`);
    }
  }

  /**
   * Detect the format of an import file
   */
  private detectFormat(content: string, filePath: string): 'postman' | 'openapi' | 'curl' | 'unknown' {
    const ext = path.extname(filePath).toLowerCase();

    // Try to parse as JSON
    try {
      const json = JSON.parse(content);

      // Check for Postman collection
      if (json.info?.schema?.includes('postman')) {
        return 'postman';
      }

      // Check for OpenAPI
      if (json.openapi || json.swagger) {
        return 'openapi';
      }
    } catch {
      // Not JSON
    }

    // Check for cURL
    if (content.trim().toLowerCase().startsWith('curl')) {
      return 'curl';
    }

    // Check for YAML OpenAPI
    if ((ext === '.yaml' || ext === '.yml') && (content.includes('openapi:') || content.includes('swagger:'))) {
      return 'openapi';
    }

    return 'unknown';
  }

  /**
   * Import a Postman collection
   */
  private async importPostman(content: string): Promise<void> {
    const collection: PostmanCollection = JSON.parse(content);
    const collectionName = collection.info.name;

    // Create collection folder
    const collectionUri = await this.fileSyncService.createCollection(collectionName);
    if (!collectionUri) {
      throw new Error('Failed to create collection folder');
    }

    // Import items recursively
    await this.importPostmanItems(collection.item, collectionUri.fsPath);

    await this.fileSyncService.refreshCollections();
    vscode.window.showInformationMessage(`Imported Postman collection: ${collectionName}`);
  }

  /**
   * Import Postman items recursively
   */
  private async importPostmanItems(items: PostmanItem[], parentPath: string): Promise<void> {
    for (const item of items) {
      if (item.item && item.item.length > 0) {
        // This is a folder
        const folderUri = await this.fileSyncService.createCollection(item.name, parentPath);
        if (folderUri) {
          await this.importPostmanItems(item.item, folderUri.fsPath);
        }
      } else if (item.request) {
        // This is a request
        const request = this.convertPostmanRequest(item);
        await this.fileSyncService.createRequest(item.name, parentPath);

        // Get the created file and update it with full request data
        const fileName = item.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.http';
        const fileUri = vscode.Uri.joinPath(vscode.Uri.file(parentPath), fileName);
        request.fileUri = fileUri;
        await this.fileSyncService.saveRequest(request, true);
      }
    }
  }

  /**
   * Convert a Postman request to UIRequest
   */
  private convertPostmanRequest(item: PostmanItem): UIRequest {
    const req = item.request!;

    // Parse URL
    let url = '';
    const queryParams: QueryParam[] = [];

    if (typeof req.url === 'string') {
      url = req.url;
    } else if (req.url) {
      url = req.url.raw || '';
      if (req.url.query) {
        for (const q of req.url.query) {
          queryParams.push({
            key: q.key,
            value: q.value,
            enabled: !q.disabled,
          });
        }
      }
    }

    // Parse headers
    const headers: RequestHeader[] = (req.header || []).map(h => ({
      key: h.key,
      value: h.value,
      enabled: !h.disabled,
    }));

    // Parse body
    const body = this.convertPostmanBody(req.body);

    return {
      id: `import-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      name: item.name,
      description: item.description,
      method: (req.method?.toUpperCase() || 'GET') as HttpMethod,
      url,
      headers,
      queryParams,
      body,
    };
  }

  /**
   * Convert Postman body to RequestBody
   */
  private convertPostmanBody(body?: PostmanBody): RequestBody {
    if (!body) return { type: 'none' };

    switch (body.mode) {
      case 'raw':
        const language = body.options?.raw?.language?.toLowerCase();
        if (language === 'json' || body.raw?.trim().startsWith('{')) {
          return { type: 'json', content: body.raw || '' };
        }
        return { type: 'raw', content: body.raw || '' };

      case 'urlencoded':
        const formContent = (body.urlencoded || [])
          .filter(f => !f.disabled)
          .map(f => `${f.key}=${f.value}`)
          .join('&');
        return { type: 'form', content: formContent };

      case 'formdata':
        return {
          type: 'formdata',
          formData: (body.formdata || []).map(f => ({
            key: f.key,
            value: f.value,
            type: f.type === 'file' ? 'file' : 'text',
            enabled: !f.disabled,
          })),
        };

      case 'graphql':
        return {
          type: 'graphql',
          graphql: {
            query: body.graphql?.query || '',
            variables: body.graphql?.variables,
          },
        };

      default:
        return { type: 'none' };
    }
  }

  /**
   * Import an OpenAPI specification
   */
  private async importOpenAPI(content: string): Promise<void> {
    // Parse YAML or JSON
    let spec: OpenAPISpec;
    try {
      spec = JSON.parse(content);
    } catch {
      // Try YAML parsing (basic)
      throw new Error('YAML OpenAPI import not yet supported. Please use JSON format.');
    }

    const collectionName = spec.info.title;
    const baseUrl = spec.servers?.[0]?.url || 'https://api.example.com';

    // Create collection folder
    const collectionUri = await this.fileSyncService.createCollection(collectionName);
    if (!collectionUri) {
      throw new Error('Failed to create collection folder');
    }

    // Group by tags
    const requestsByTag = new Map<string, UIRequest[]>();

    for (const [pathStr, pathObj] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(pathObj)) {
        if (typeof operation !== 'object') continue;

        const op = operation as OpenAPIOperation;
        const tag = op.tags?.[0] || 'Default';

        const request = this.convertOpenAPIOperation(pathStr, method, op, baseUrl);

        if (!requestsByTag.has(tag)) {
          requestsByTag.set(tag, []);
        }
        requestsByTag.get(tag)!.push(request);
      }
    }

    // Create folders for tags and requests
    for (const [tag, requests] of requestsByTag) {
      const tagUri = await this.fileSyncService.createCollection(tag, collectionUri.fsPath);
      if (!tagUri) continue;

      for (const request of requests) {
        const fileName = (request.name || 'request').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.http';
        const fileUri = vscode.Uri.joinPath(tagUri, fileName);
        request.fileUri = fileUri;
        await this.fileSyncService.saveRequest(request, true);
      }
    }

    await this.fileSyncService.refreshCollections();
    vscode.window.showInformationMessage(`Imported OpenAPI spec: ${collectionName}`);
  }

  /**
   * Convert an OpenAPI operation to UIRequest
   */
  private convertOpenAPIOperation(
    path: string,
    method: string,
    operation: OpenAPIOperation,
    baseUrl: string
  ): UIRequest {
    const headers: RequestHeader[] = [];
    const queryParams: QueryParam[] = [];

    // Process parameters
    for (const param of operation.parameters || []) {
      if (param.in === 'header') {
        headers.push({
          key: param.name,
          value: String(param.schema?.default || ''),
          enabled: true,
        });
      } else if (param.in === 'query') {
        queryParams.push({
          key: param.name,
          value: String(param.schema?.default || ''),
          enabled: true,
        });
      }
    }

    // Detect body type from requestBody
    let body: RequestBody = { type: 'none' };
    if (operation.requestBody?.content) {
      const contentTypes = Object.keys(operation.requestBody.content);
      if (contentTypes.includes('application/json')) {
        body = { type: 'json', content: '{}' };
        headers.push({ key: 'Content-Type', value: 'application/json', enabled: true });
      } else if (contentTypes.includes('application/x-www-form-urlencoded')) {
        body = { type: 'form', content: '' };
        headers.push({ key: 'Content-Type', value: 'application/x-www-form-urlencoded', enabled: true });
      }
    }

    return {
      id: `openapi-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      name: operation.summary || operation.operationId || `${method.toUpperCase()} ${path}`,
      description: operation.description,
      method: method.toUpperCase() as HttpMethod,
      url: `${baseUrl}${path}`,
      headers,
      queryParams,
      body,
    };
  }

  /**
   * Import a cURL command
   */
  private async importCurl(content: string): Promise<void> {
    // Basic cURL parsing
    const request = this.parseCurl(content);

    const collectionPath = this.fileSyncService.rootUri?.fsPath;
    if (!collectionPath) {
      throw new Error('No collection folder found');
    }

    await this.fileSyncService.createRequest(request.name || 'cURL Import', collectionPath);

    await this.fileSyncService.refreshCollections();
    vscode.window.showInformationMessage('Imported cURL command');
  }

  /**
   * Parse a cURL command into UIRequest
   */
  private parseCurl(curl: string): UIRequest {
    const lines = curl.split(/\s*\\\s*\n/).join(' ');
    const parts = lines.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];

    let method: HttpMethod = 'GET';
    let url = '';
    const headers: RequestHeader[] = [];
    let bodyContent = '';

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i].replace(/^['"]|['"]$/g, '');

      switch (part.toLowerCase()) {
        case 'curl':
          continue;
        case '-x':
        case '--request':
          method = (parts[++i]?.replace(/^['"]|['"]$/g, '').toUpperCase() || 'GET') as HttpMethod;
          break;
        case '-h':
        case '--header':
          const header = parts[++i]?.replace(/^['"]|['"]$/g, '') || '';
          const colonIdx = header.indexOf(':');
          if (colonIdx > 0) {
            headers.push({
              key: header.slice(0, colonIdx).trim(),
              value: header.slice(colonIdx + 1).trim(),
              enabled: true,
            });
          }
          break;
        case '-d':
        case '--data':
        case '--data-raw':
          bodyContent = parts[++i]?.replace(/^['"]|['"]$/g, '') || '';
          if (method === 'GET') method = 'POST';
          break;
        default:
          if (part.startsWith('http://') || part.startsWith('https://')) {
            url = part;
          }
      }
    }

    let body: RequestBody = { type: 'none' };
    if (bodyContent) {
      try {
        JSON.parse(bodyContent);
        body = { type: 'json', content: bodyContent };
      } catch {
        body = { type: 'raw', content: bodyContent };
      }
    }

    return {
      id: `curl-${Date.now()}`,
      name: 'cURL Import',
      method,
      url,
      headers,
      queryParams: [],
      body,
    };
  }

  /**
   * Export to Postman collection format
   */
  private async exportToPostman(node: CollectionTreeNode): Promise<string> {
    const collection: PostmanCollection = {
      info: {
        name: node.label,
        description: node.description || '',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item: await this.convertToPostmanItems(node.children || []),
    };

    return JSON.stringify(collection, null, 2);
  }

  /**
   * Convert tree nodes to Postman items
   */
  private async convertToPostmanItems(nodes: CollectionTreeNode[]): Promise<PostmanItem[]> {
    const items: PostmanItem[] = [];

    for (const node of nodes) {
      if (node.type === 'request') {
        const request = await this.fileSyncService.getRequest(vscode.Uri.file(node.filePath));
        if (request) {
          items.push({
            name: request.name,
            description: request.description,
            request: {
              method: request.method,
              header: request.headers
                .filter(h => h.enabled)
                .map(h => ({ key: h.key, value: h.value })),
              url: {
                raw: this.buildFullUrl(request),
                query: request.queryParams
                  .filter(p => p.enabled)
                  .map(p => ({ key: p.key, value: p.value })),
              },
              body: this.convertToPostmanBody(request.body),
            },
          });
        }
      } else {
        items.push({
          name: node.label,
          description: node.description,
          item: await this.convertToPostmanItems(node.children || []),
        });
      }
    }

    return items;
  }

  /**
   * Build full URL with query params
   */
  private buildFullUrl(request: UIRequest): string {
    const params = request.queryParams.filter(p => p.enabled);
    if (params.length === 0) return request.url;

    const queryString = params.map(p => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`).join('&');
    return `${request.url}?${queryString}`;
  }

  /**
   * Convert RequestBody to Postman body
   */
  private convertToPostmanBody(body: RequestBody): PostmanBody | undefined {
    switch (body.type) {
      case 'none':
        return undefined;
      case 'json':
      case 'raw':
        return {
          mode: 'raw',
          raw: body.content || '',
          options: body.type === 'json' ? { raw: { language: 'json' } } : undefined,
        };
      case 'form':
        return {
          mode: 'urlencoded',
          urlencoded: (body.content || '')
            .split('&')
            .filter(Boolean)
            .map(pair => {
              const [key, value] = pair.split('=');
              return { key: decodeURIComponent(key || ''), value: decodeURIComponent(value || '') };
            }),
        };
      case 'formdata':
        return {
          mode: 'formdata',
          formdata: (body.formData || [])
            .filter(f => f.enabled)
            .map(f => ({ key: f.key, value: f.value, type: f.type })),
        };
      case 'graphql':
        return {
          mode: 'graphql',
          graphql: body.graphql,
        };
      default:
        return undefined;
    }
  }

  /**
   * Export to HAR format
   */
  private async exportToHAR(node: CollectionTreeNode): Promise<string> {
    const entries = await this.collectHAREntries(node.children || []);

    const har = {
      log: {
        version: '1.2',
        creator: {
          name: 'httpyac REST Client',
          version: '1.0',
        },
        entries,
      },
    };

    return JSON.stringify(har, null, 2);
  }

  /**
   * Collect HAR entries from tree nodes
   */
  private async collectHAREntries(nodes: CollectionTreeNode[]): Promise<unknown[]> {
    const entries: unknown[] = [];

    for (const node of nodes) {
      if (node.type === 'request') {
        const request = await this.fileSyncService.getRequest(vscode.Uri.file(node.filePath));
        if (request) {
          entries.push({
            startedDateTime: new Date().toISOString(),
            time: 0,
            request: {
              method: request.method,
              url: this.buildFullUrl(request),
              httpVersion: 'HTTP/1.1',
              headers: request.headers.filter(h => h.enabled).map(h => ({ name: h.key, value: h.value })),
              queryString: request.queryParams.filter(p => p.enabled).map(p => ({ name: p.key, value: p.value })),
              cookies: [],
              headersSize: -1,
              bodySize: request.body.content?.length || 0,
              postData:
                request.body.type !== 'none'
                  ? {
                      mimeType: this.getMimeType(request.body.type),
                      text: request.body.content || '',
                    }
                  : undefined,
            },
            response: {
              status: 0,
              statusText: '',
              httpVersion: 'HTTP/1.1',
              headers: [],
              cookies: [],
              content: { size: 0, mimeType: 'text/plain' },
              redirectURL: '',
              headersSize: -1,
              bodySize: -1,
            },
            cache: {},
            timings: { send: 0, wait: 0, receive: 0 },
          });
        }
      } else {
        entries.push(...(await this.collectHAREntries(node.children || [])));
      }
    }

    return entries;
  }

  /**
   * Get MIME type for body type
   */
  private getMimeType(bodyType: string): string {
    switch (bodyType) {
      case 'json':
        return 'application/json';
      case 'form':
        return 'application/x-www-form-urlencoded';
      case 'formdata':
        return 'multipart/form-data';
      case 'graphql':
        return 'application/json';
      default:
        return 'text/plain';
    }
  }
}

