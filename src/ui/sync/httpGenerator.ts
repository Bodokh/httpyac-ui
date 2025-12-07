import { UIRequest, RequestHeader, QueryParam } from '../types';

/**
 * Generates .http file content from a UIRequest
 */
export class HttpGenerator {
  /**
   * Generate the full .http file content for a request
   */
  generate(request: UIRequest): string {
    const lines: string[] = [];

    // Add metadata comments
    if (request.name) {
      lines.push(`# @name ${request.name}`);
    }
    if (request.description) {
      lines.push(`# @description ${request.description}`);
    }
    if (request.tags?.length) {
      lines.push(`# @tag ${request.tags.join(', ')}`);
    }
    if (lines.length > 0) {
      lines.push('');
    }

    // Add pre-request script
    if (request.preRequest?.trim()) {
      lines.push('{{');
      lines.push('  // @pre');
      lines.push(...request.preRequest.split('\n').map(l => `  ${l}`));
      lines.push('}}');
      lines.push('');
    }

    // Build URL with query params
    const url = this.buildUrl(request.url, request.queryParams);
    lines.push(`${request.method} ${url}`);

    // Add headers
    const enabledHeaders = request.headers.filter(h => h.enabled && h.key);
    for (const header of enabledHeaders) {
      lines.push(`${header.key}: ${header.value}`);
    }

    // Add body
    const bodyContent = this.generateBody(request);
    if (bodyContent) {
      lines.push('');
      lines.push(bodyContent);
    }

    // Add test script
    if (request.tests?.trim()) {
      lines.push('');
      lines.push('{{');
      lines.push(...request.tests.split('\n').map(l => `  ${l}`));
      lines.push('}}');
    }

    // Add separator
    lines.push('');
    lines.push('###');

    return lines.join('\n');
  }

  /**
   * Build URL with query parameters
   */
  private buildUrl(baseUrl: string, queryParams: QueryParam[]): string {
    const enabledParams = queryParams.filter(p => p.enabled && p.key);
    if (enabledParams.length === 0) {
      return baseUrl;
    }

    const queryString = enabledParams.map(p => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`).join('&');

    return `${baseUrl}?${queryString}`;
  }

  /**
   * Generate body content based on type
   */
  private generateBody(request: UIRequest): string | undefined {
    const { body } = request;

    switch (body.type) {
      case 'none':
        return undefined;

      case 'json':
        return body.content || '';

      case 'raw':
        return body.content || '';

      case 'form': {
        return body.content || '';
      }

      case 'formdata': {
        if (body.formData?.length) {
          return body.formData
            .filter(f => f.enabled)
            .map(f => `${f.key}=${f.value}`)
            .join('\n');
        }
        return body.content || '';
      }

      case 'graphql': {
        if (body.graphql) {
          const gql: Record<string, unknown> = { query: body.graphql.query };
          if (body.graphql.variables) {
            try {
              gql.variables = JSON.parse(body.graphql.variables);
            } catch {
              gql.variables = body.graphql.variables;
            }
          }
          return JSON.stringify(gql, null, 2);
        }
        return undefined;
      }

      case 'binary':
        return body.content ? `< ${body.content}` : undefined;

      default:
        return undefined;
    }
  }

  /**
   * Ensure Content-Type header is set correctly for body type
   */
  ensureContentTypeHeader(request: UIRequest): RequestHeader[] {
    const headers = [...request.headers];
    const contentTypeIndex = headers.findIndex(h => h.key.toLowerCase() === 'content-type');

    let contentType: string | undefined;

    switch (request.body.type) {
      case 'json':
        contentType = 'application/json';
        break;
      case 'form':
        contentType = 'application/x-www-form-urlencoded';
        break;
      case 'formdata':
        contentType = 'multipart/form-data';
        break;
      case 'graphql':
        contentType = 'application/json';
        break;
      case 'raw':
        contentType = 'text/plain';
        break;
      default:
        // 'none' or 'binary' - no content-type needed
        break;
    }

    if (contentType) {
      if (contentTypeIndex >= 0) {
        headers[contentTypeIndex] = { ...headers[contentTypeIndex], value: contentType };
      } else {
        headers.push({ key: 'Content-Type', value: contentType, enabled: true });
      }
    }

    return headers;
  }
}

/**
 * Singleton instance
 */
export const httpGenerator = new HttpGenerator();
