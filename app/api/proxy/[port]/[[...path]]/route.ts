import { NextRequest, NextResponse } from 'next/server';

/**
 * Reverse proxy for dev servers.
 * Proxies requests from /api/proxy/{port}/path to http://localhost:{port}/path
 *
 * This allows HTTPS Homestead to embed HTTP dev servers in iframes without
 * mixed content issues. All requests (HTML, JS, CSS, images) go through this proxy.
 */

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ port: string; path?: string[] }> }
) {
  const { port, path } = await params;
  return proxyRequest(request, port, path);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ port: string; path?: string[] }> }
) {
  const { port, path } = await params;
  return proxyRequest(request, port, path, 'POST');
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ port: string; path?: string[] }> }
) {
  const { port, path } = await params;
  return proxyRequest(request, port, path, 'PUT');
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ port: string; path?: string[] }> }
) {
  const { port, path } = await params;
  return proxyRequest(request, port, path, 'DELETE');
}

async function proxyRequest(
  request: NextRequest,
  port: string,
  path: string[] | undefined,
  method: string = 'GET'
) {
  const portNum = parseInt(port, 10);
  if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
    return NextResponse.json({ error: 'Invalid port' }, { status: 400 });
  }

  // Build target URL
  const pathStr = path ? `/${path.join('/')}` : '';
  const searchParams = request.nextUrl.search;
  const targetUrl = `http://localhost:${portNum}${pathStr}${searchParams}`;

  try {
    // Forward the request
    const headers = new Headers();
    request.headers.forEach((value, key) => {
      // Skip headers that shouldn't be forwarded
      if (!['host', 'connection', 'content-length'].includes(key.toLowerCase())) {
        headers.set(key, value);
      }
    });

    const fetchOptions: RequestInit = {
      method,
      headers,
      redirect: 'manual', // Handle redirects ourselves
    };

    // Forward body for POST/PUT
    if (method !== 'GET' && method !== 'HEAD') {
      const body = await request.arrayBuffer();
      if (body.byteLength > 0) {
        fetchOptions.body = body;
      }
    }

    const response = await fetch(targetUrl, fetchOptions);

    // Handle redirects - rewrite Location header to go through proxy
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) {
        // Convert absolute paths to proxy paths
        let newLocation = location;
        if (location.startsWith('/')) {
          newLocation = `/api/proxy/${port}${location}`;
        } else if (location.startsWith(`http://localhost:${port}`)) {
          newLocation = location.replace(`http://localhost:${port}`, `/api/proxy/${port}`);
        }
        return new NextResponse(null, {
          status: response.status,
          headers: { Location: newLocation },
        });
      }
    }

    // Get response body
    const responseBody = await response.arrayBuffer();
    const contentType = response.headers.get('content-type') || '';

    // For HTML responses, rewrite URLs to go through proxy
    if (contentType.includes('text/html')) {
      let html = new TextDecoder().decode(responseBody);
      html = rewriteHtml(html, port);
      return new NextResponse(html, {
        status: response.status,
        headers: buildResponseHeaders(response, 'text/html; charset=utf-8'),
      });
    }

    // For CSS, rewrite url() references
    if (contentType.includes('text/css')) {
      let css = new TextDecoder().decode(responseBody);
      css = rewriteCss(css, port);
      return new NextResponse(css, {
        status: response.status,
        headers: buildResponseHeaders(response, 'text/css; charset=utf-8'),
      });
    }

    // For JavaScript, rewrite fetch/import URLs
    if (contentType.includes('javascript') || contentType.includes('application/json')) {
      let js = new TextDecoder().decode(responseBody);
      js = rewriteJs(js, port);
      return new NextResponse(js, {
        status: response.status,
        headers: buildResponseHeaders(response, contentType),
      });
    }

    // For other content, pass through as-is
    return new NextResponse(responseBody, {
      status: response.status,
      headers: buildResponseHeaders(response, contentType),
    });
  } catch (error) {
    console.error(`Proxy error for ${targetUrl}:`, error);
    return NextResponse.json(
      { error: 'Failed to proxy request', details: String(error) },
      { status: 502 }
    );
  }
}

function buildResponseHeaders(response: Response, contentType: string): Headers {
  const headers = new Headers();
  headers.set('content-type', contentType);

  // Forward cache headers
  const cacheControl = response.headers.get('cache-control');
  if (cacheControl) headers.set('cache-control', cacheControl);

  const etag = response.headers.get('etag');
  if (etag) headers.set('etag', etag);

  const lastModified = response.headers.get('last-modified');
  if (lastModified) headers.set('last-modified', lastModified);

  return headers;
}

function rewriteHtml(html: string, port: string): string {
  const proxyBase = `/api/proxy/${port}`;

  // Rewrite src and href attributes that start with /
  // Matches: src="/" href="/" src='/' href='/'
  html = html.replace(
    /(src|href|action)=(["'])\//g,
    `$1=$2${proxyBase}/`
  );

  // Rewrite srcset attributes
  html = html.replace(
    /srcset=(["'])([^"']+)(["'])/g,
    (match, q1, srcset, q2) => {
      const rewritten = srcset.replace(/(\s|^)\//g, `$1${proxyBase}/`);
      return `srcset=${q1}${rewritten}${q2}`;
    }
  );

  // Inject a base tag if none exists (helps with relative URLs)
  if (!html.includes('<base')) {
    html = html.replace('<head>', `<head><base href="${proxyBase}/">`);
  }

  return html;
}

function rewriteCss(css: string, port: string): string {
  const proxyBase = `/api/proxy/${port}`;

  // Rewrite url() references that start with /
  css = css.replace(
    /url\((["']?)\/([^)]+)\)/g,
    `url($1${proxyBase}/$2)`
  );

  return css;
}

function rewriteJs(js: string, port: string): string {
  const proxyBase = `/api/proxy/${port}`;

  // Rewrite fetch() calls with absolute paths
  // This is tricky - we do best-effort for common patterns

  // fetch("/api/...") or fetch('/api/...')
  js = js.replace(
    /fetch\((["'])\/([^"']+)(["'])/g,
    `fetch($1${proxyBase}/$2$3`
  );

  // Dynamic imports: import("/...")
  js = js.replace(
    /import\((["'])\/([^"']+)(["'])\)/g,
    `import($1${proxyBase}/$2$3)`
  );

  return js;
}
