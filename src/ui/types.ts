import * as vscode from 'vscode';
import * as httpyac from 'httpyac';

/**
 * HTTP methods supported by the UI
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS' | 'CONNECT' | 'TRACE';

/**
 * Status of a request's last execution
 */
export type RequestStatus = 'success' | 'error' | 'pending' | 'none';

/**
 * Tree item types in the collections panel
 */
export type CollectionItemType = 'collection' | 'folder' | 'request';

/**
 * Represents a node in the collection tree
 */
export interface CollectionTreeNode {
  type: CollectionItemType;
  id: string;
  label: string;
  description?: string;
  method?: HttpMethod;
  filePath: string;
  folderPath: string;
  children?: CollectionTreeNode[];
  lastRunStatus?: RequestStatus;
  testsPassed?: number;
  testsFailed?: number;
  order?: number;
}

/**
 * Collection metadata stored in _collection.json
 */
export interface CollectionMetadata {
  name: string;
  description?: string;
  order?: string[];
  variables?: Record<string, string>;
  auth?: AuthConfig;
  created?: string;
  modified?: string;
}

/**
 * Authentication configuration
 */
export interface AuthConfig {
  type: 'none' | 'basic' | 'bearer' | 'oauth2' | 'apikey';
  username?: string;
  password?: string;
  token?: string;
  apiKey?: string;
  apiKeyHeader?: string;
  oauth2?: OAuth2Config;
}

/**
 * OAuth2 configuration
 */
export interface OAuth2Config {
  grantType: 'authorization_code' | 'client_credentials' | 'password' | 'implicit';
  authorizationUrl?: string;
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  redirectUri?: string;
}

/**
 * Request header
 */
export interface RequestHeader {
  key: string;
  value: string;
  enabled: boolean;
  description?: string;
}

/**
 * Query parameter
 */
export interface QueryParam {
  key: string;
  value: string;
  enabled: boolean;
  description?: string;
}

/**
 * Request body configuration
 */
export interface RequestBody {
  type: 'none' | 'json' | 'form' | 'formdata' | 'raw' | 'binary' | 'graphql';
  content?: string;
  formData?: Array<{ key: string; value: string; type: 'text' | 'file'; enabled: boolean }>;
  graphql?: {
    query: string;
    variables?: string;
  };
}

/**
 * UI representation of an HTTP request
 */
export interface UIRequest {
  id: string;
  name: string;
  description?: string;
  method: HttpMethod;
  url: string;
  headers: RequestHeader[];
  queryParams: QueryParam[];
  body: RequestBody;
  auth?: AuthConfig;
  tests?: string;
  preRequest?: string;
  tags?: string[];
  fileUri?: vscode.Uri;
  collectionPath?: string;
}

/**
 * UI representation of an HTTP response
 */
export interface UIResponse {
  id: string;
  requestId: string;
  statusCode: number;
  statusText: string;
  headers: Record<string, string>;
  cookies: Array<{ name: string; value: string; domain?: string; path?: string }>;
  body: string;
  bodyType: 'json' | 'xml' | 'html' | 'text' | 'binary';
  size: number;
  time: number;
  timings?: httpyac.TimingEvents;
  testResults?: httpyac.TestResult[];
}

/**
 * Environment configuration
 */
export interface Environment {
  name: string;
  variables: Record<string, string>;
  filePath: string;
  isActive?: boolean;
}

/**
 * Message types for webview communication
 */
export type WebviewMessageType =
  | 'ready'
  | 'save'
  | 'send'
  | 'cancel'
  | 'updateRequest'
  | 'updateHeader'
  | 'updateBody'
  | 'updateAuth'
  | 'selectEnvironment'
  | 'createRequest'
  | 'createCollection'
  | 'deleteRequest'
  | 'deleteCollection'
  | 'renameItem'
  | 'duplicateRequest'
  | 'reorderItems'
  | 'importCollection'
  | 'exportCollection'
  | 'openRawView'
  | 'copyResponse'
  | 'saveResponse'
  | 'formatResponse';

/**
 * Message sent from webview to extension
 */
export interface WebviewMessage {
  type: WebviewMessageType;
  payload?: unknown;
  requestId?: string;
}

/**
 * Message sent from extension to webview
 */
export interface ExtensionMessage {
  type: 'requestLoaded' | 'responseReceived' | 'error' | 'environmentChanged' | 'collectionsUpdated' | 'requestProgress' | 'requestCancelled';
  payload: unknown;
}

/**
 * UI configuration settings
 */
export interface UIConfig {
  enabled: boolean;
  rootFolder: string;
  defaultView: 'split' | 'tabs';
  autoSave: boolean;
  autoSaveDelay: number;
  showMethodBadges: boolean;
  theme: 'auto' | 'light' | 'dark';
}

/**
 * Root collections.json structure
 */
export interface CollectionsManifest {
  version: string;
  collections: string[];
  activeEnvironment?: string;
  lastModified: string;
}

