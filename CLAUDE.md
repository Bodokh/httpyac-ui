# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

vscode-httpyac is a Visual Studio Code extension that allows users to send REST, SOAP, GraphQL, gRPC, MQTT, RabbitMQ and WebSocket requests directly within the editor. The extension provides a rich environment for HTTP request testing with support for variables, environments, response viewing, test execution, and code generation.

This extension is a VS Code wrapper around the core `httpyac` library (npm package), which handles the actual HTTP request parsing, execution, and processing.

## Build and Development Commands

### Building the Extension
```bash
npm run compile        # Production build (minified)
npm run esbuild        # Development build
npm run watch          # Watch mode for development
npm run compile-web    # Build for web/browser environment
```

### Code Quality
```bash
npm run lint           # Run all linters (format + eslint + lockfile-lint + tsc)
npm run format         # Format code with Prettier
npm run eslint         # Run ESLint on TypeScript files
npm test               # No tests defined in this project
```

### Packaging
```bash
npm run package        # Create .vsix package file for distribution
```

### Pre-commit
```bash
npm run precommit      # Runs lint before commit (via husky)
```

## Architecture Overview

### Core Stores (State Management)

The extension uses two central stores that maintain state:

1. **DocumentStore** (`src/documentStore.ts`): Manages HTTP file parsing and caching
   - Wraps the `httpyac.store.HttpFileStore` from the core library
   - Parses `.http` and `.rest` files into `HttpFile` objects containing `HttpRegion`s
   - Manages active environments per file or globally
   - Emits events when documents change, are renamed, or deleted
   - Handles the `send()` operation for executing HTTP requests

2. **ResponseStore** (`src/responseStore.ts`): Manages HTTP response history and display
   - Caches response items (max 50 by default, configurable)
   - Manages response file storage via `StorageProvider`
   - Coordinates multiple `ResponseHandler`s for displaying responses
   - Handles pretty-printing and response shrinking

### Provider Pattern

The extension uses VS Code's provider pattern extensively. All providers are registered in `src/extension.ts` during activation. Key providers include:

- **CodeLensProvider**: Shows "send", "send all", etc. actions above HTTP requests
- **CompletionItemProvider**: Provides IntelliSense for HTTP syntax
- **DefinitionProvider**: Jump-to-definition for variables and references
- **DocumentSymbolProvider**: Outline view for HTTP files
- **FoldingRangeProvider**: Code folding for HTTP regions
- **HoverProvider**: Variable value previews on hover
- **DecorationProvider**: Visual borders around HTTP request regions

### View Controllers (Tree Views)

Custom tree view providers for the httpyac sidebar:
- **HistoryController**: Response history view
- **EnvironmentTreeDataProvider**: Available environments
- **VariablesTreeDataProvider**: Current variable values
- **UserSessionTreeDataProvider**: OAuth/auth sessions
- **DebugTreeDataProvider**: HttpFile object inspection (hidden by default)

### Test Integration

The extension includes VS Code Test Controller support (`src/provider/test/`):
- **TestController**: Registers and manages test items
- **TestItemResolver**: Discovers HTTP files and regions as test items
- **TestRunner**: Executes tests and reports results
- Test hierarchy can be flat, flattened, or filesystem-based (configurable)

### Request/Response Handlers

Response display is handled by a chain of handlers in `src/view/`:
- **saveFileResponseHandler**: Saves response to disk
- **noResponseViewResponseHandler**: Output channel only (when responseViewMode is "none")
- **openWithResponseHandler**: Opens in standard editor
- **previewResponseHandler**: Preview mode (default)

### Plugin System

The extension integrates with httpyac's plugin system (`src/plugin/`):
- **vscodeHttpyacPlugin**: Core VS Code integration hooks
- **outputChannelProvider**: Routes httpyac logs to VS Code output channels
- **bailOnFailedTestInterceptor**: Test execution control
- **errorNotificationHandler**: Shows VS Code error notifications

### IO Providers

Custom IO implementations for VS Code (`src/io/`):
- **fileProvider**: Reads files using VS Code workspace APIs
- **userInteractionProvider**: Prompts, selections, progress indicators
- **storageProvider**: Manages response file storage (global/workspace/file-based)

## Key Concepts

### HttpFile and HttpRegion

- An **HttpFile** represents a parsed `.http`/`.rest` file
- It contains one or more **HttpRegion** objects
- Each HttpRegion represents a single HTTP request block (separated by `###` delimiters)
- Regions can have metadata like name, description, and associated tests

### Environments and Variables

- Environments are activated via `environmentSelectedOnStart` setting or UI toggle
- Variables can be defined in:
  - `.env` files (in `env/` folder by default)
  - `http-client.env.json` files
  - `.httpyac.js` or `.httpyac.json` config files
  - VS Code settings (`httpyac.environmentVariables`)
  - Inline in `.http` files using `@variableName = value`
- Variable resolution order: request-scoped → file-scoped → environment → config → settings

### Response Storage

Responses can be stored in different locations (via `httpyac.responseStorage` setting):
- `global`: User's global storage directory
- `workspace`: `.httpyac` folder in workspace
- `file`: Next to the `.http` file
- `none`: No persistent storage

## Important Implementation Notes

### Document Selectors

The extension defines document selectors in `src/config.ts`:
- `httpDocumentSelector`: `.http` and `.rest` files
- `allHttpDocumentSelector`: Includes markdown and asciidoc with embedded HTTP blocks
- `outputDocumentSelector`: Response preview documents

### VSCode API Integration

- Extension activation happens on multiple events (see `package.json` `activationEvents`)
- Commands are prefixed with `httpyac.` (see `src/config.ts` commands object)
- Keybindings are only active when `editorLangId in httpyac.supportedLanguages`

### Core Library Dependency

This extension depends on `httpyac` npm package (version ^6.16.7). The core library:
- Parses HTTP files into structured data
- Executes HTTP requests
- Manages variables, environments, and user sessions
- Provides plugin hooks for extension integration
- Never modify httpyac's behavior directly; use the plugin system

### Configuration Sources

The extension reads configuration from multiple sources (priority order):
1. `.httpyac.js` or `.httpyac.config.js` (JavaScript config)
2. `.httpyac.json` or `httpyac.config.json` (JSON config)
3. `http-client.env.json` (environment variables)
4. VS Code workspace settings (`httpyac.*`)
5. Default values

### Working with Requests

To execute a request programmatically:
```typescript
const context = await documentStore.send({
  httpRegion,
  httpFile,
  activeEnvironment: ['dev'],
  // optional: scriptConsole, config, etc.
});
```

The DocumentStore handles environment resolution, logging setup, and variable management.

## Testing Notes

This repository does not have a test suite. Testing is done manually via:
- Running the extension in development mode (F5 in VS Code)
- Using the example files in the `examples/` directory
- Installing the packaged `.vsix` file

## Code Style

- Strict TypeScript with all strict flags enabled
- ESLint with TypeScript plugin (see `.eslintrc.yml`)
- Prettier for formatting (see `.prettierrc.yaml`)
- Prefer arrow functions and const over let/var
- No console.log in production (use httpyac logging)
- Use EventEmitter pattern for cross-component communication

## Common Development Workflows

### Adding a New Command

1. Add command ID to `src/config.ts` commands object
2. Register command in `package.json` contributes.commands
3. Implement handler in appropriate controller (usually `RequestCommandsController`)
4. Add to command palette menu in `package.json` contributes.menus
5. Optional: Add keybinding in `package.json` contributes.keybindings

### Adding a New Setting

1. Define TypeScript interface in `src/config.ts` (ResourceConfig or AppConfig)
2. Add schema to `package.json` contributes.configuration.properties
3. Update `getConfigSetting()` or `getEnvironmentConfig()` to read the setting
4. Use `watchConfigSettings()` if cache invalidation is needed on change

### Debugging Response Issues

1. Check `ResponseStore.responseHandlers` chain
2. Verify `responseViewMode` setting (preview/reuse/open/none)
3. Check storage provider for file writes
4. Review Output channel "httpYac" for logs (set `httpyac.logLevel` to "debug")
5. Inspect response item in Debug tree view (enable in httpyac sidebar)

### Working with httpyac Core Library

- Import as `import * as httpyac from 'httpyac'`
- Key exports: `send()`, `HttpFile`, `HttpRegion`, `store`, `io`, `utils`
- Register plugins via `httpFileStore` config in constructor
- Never directly manipulate httpyac internals; use public API and plugin hooks

## REST Client UI (src/ui/)

The extension includes a Thunder Client-like graphical UI for managing HTTP requests with a sidebar collections view and webview-based editors.

### UI Architecture

```
src/ui/
├── types.ts                    # Type definitions for UI components
├── uiController.ts             # Main controller coordinating UI components
├── collectionsPanel/           # Sidebar tree view
│   ├── collectionsTreeProvider.ts
│   ├── collectionTreeItem.ts
│   └── commands.ts
├── requestEditor/              # Webview-based request editor
│   └── requestEditorProvider.ts
├── responseViewer/             # Webview-based response viewer
│   └── responseViewerProvider.ts
├── sync/                       # Two-way file synchronization
│   ├── fileSyncService.ts
│   ├── collectionParser.ts
│   └── httpGenerator.ts
└── import/                     # Import/export functionality
    └── importExportService.ts
```

### File Storage Structure

Requests are stored in a `.rest/` folder (configurable via `httpyac.ui.rootFolder`):

```
.rest/
├── collections.json            # Root manifest
├── environments/               # Environment variables
│   ├── dev.env
│   └── prod.env
├── User/                       # Collection folder
│   ├── _collection.json        # Collection metadata
│   ├── Account/                # Sub-collection
│   │   └── login.http
│   └── get-profile.http
└── Orders/
    └── create-order.http
```

### Key UI Components

1. **UIController** (`src/ui/uiController.ts`): Orchestrates all UI components
   - Initializes FileSyncService and tree provider
   - Handles configuration changes
   - Connects request selection to editor opening

2. **CollectionsTreeProvider**: Sidebar tree view
   - Parses folder structure into tree nodes
   - Supports CRUD operations on collections/requests
   - Provides context menu actions

3. **FileSyncService**: Two-way sync between UI and files
   - Watches for file changes with FileSystemWatcher
   - Debounces writes to prevent rapid updates
   - Emits events for collection/environment changes

4. **RequestEditorProvider**: Webview for editing requests
   - Method/URL/Headers/Body editing
   - Inline response display
   - Integration with httpyac execution

5. **ImportExportService**: Collection import/export
   - Postman Collection v2.1 import
   - OpenAPI/Swagger import
   - cURL command import
   - Export to Postman/HAR formats

### UI Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `httpyac.ui.enabled` | `true` | Enable/disable the UI panel |
| `httpyac.ui.rootFolder` | `.rest` | Folder for storing collections |
| `httpyac.ui.autoSave` | `true` | Auto-save request changes |
| `httpyac.ui.autoSaveDelay` | `300` | Debounce delay in ms |
| `httpyac.ui.showMethodBadges` | `true` | Show HTTP method badges |

### UI Commands

| Command | Description |
|---------|-------------|
| `httpyac.ui.newRequest` | Create a new request |
| `httpyac.ui.newCollection` | Create a new collection |
| `httpyac.ui.deleteItem` | Delete request/collection |
| `httpyac.ui.renameItem` | Rename request/collection |
| `httpyac.ui.duplicateRequest` | Duplicate a request |
| `httpyac.ui.sendRequest` | Send request from tree |
| `httpyac.ui.importCollection` | Import from Postman/OpenAPI/cURL |
| `httpyac.ui.exportCollection` | Export to Postman/HAR |

### Adding UI Features

1. **New tree view action**: Add to `src/ui/collectionsPanel/commands.ts`, register in `collectionsTreeProvider.ts`, add menu item in `package.json`
2. **New webview feature**: Modify the HTML template in the provider, handle messages in `handleMessage()`
3. **New file format support**: Extend `ImportExportService` with new detection and conversion logic
