/**
 * Chrome DevTools Protocol helpers
 */

import WebSocket from 'ws';

const CDP_URL = 'http://127.0.0.1:9222';

/**
 * Wait for a page with the given unique ID to appear in the CDP page list
 */
export async function waitForPageInList(uniqueId, maxAttempts = 20) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`${CDP_URL}/json`);
      const pages = await response.json();
      const page = pages.find(p =>
        p.type === 'page' && p.url.includes(uniqueId)
      );
      if (page) return page;
    } catch (e) {
      // Chrome not ready yet
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return null;
}

/**
 * Wait for a page to be fully loaded
 */
export async function waitForPageReady(page, targetUrl, maxAttempts = 30) {
  const urlWithoutQuery = targetUrl.split('?')[0];

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const result = await new Promise((resolve) => {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        let resolved = false;

        ws.on('open', () => {
          ws.send(JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: {
              expression: `JSON.stringify({
                hasBody: !!document.body,
                url: location.href,
                readyState: document.readyState
              })`,
              returnByValue: true
            }
          }));
        });

        ws.on('message', (data) => {
          if (resolved) return;
          const msg = JSON.parse(data.toString());
          if (msg.id === 1) {
            resolved = true;
            ws.close();
            try {
              resolve(JSON.parse(msg.result?.result?.value || '{}'));
            } catch {
              resolve({});
            }
          }
        });

        ws.on('error', () => {
          if (!resolved) { resolved = true; ws.close(); resolve({}); }
        });

        setTimeout(() => {
          if (!resolved) { resolved = true; ws.close(); resolve({}); }
        }, 1500);
      });

      if (result.hasBody && result.url && result.url.includes(urlWithoutQuery)) {
        return true;
      }
    } catch (e) {
      // Not ready yet
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

/**
 * Inject the overlay div into the page
 */
export async function injectOverlay(page, featureName, instructions, sessionId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl);

    ws.on('open', () => {
      // Convert instructions array to numbered HTML list
      const instructionsHtml = instructions
        .map((inst, i) => `${i + 1}. ${inst}`)
        .join('<br>');

      const script = `
        (function() {
          // Remove any existing test div
          const existing = document.getElementById('claude-test-overlay');
          if (existing) existing.remove();

          // localStorage keys for persistence
          const STORAGE_KEY = 'claude-test-overlay-prefs';

          function loadPrefs() {
            try {
              const saved = localStorage.getItem(STORAGE_KEY);
              return saved ? JSON.parse(saved) : {};
            } catch { return {}; }
          }

          function savePrefs(prefs) {
            try {
              const current = loadPrefs();
              localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, ...prefs }));
            } catch {}
          }

          const prefs = loadPrefs();

          // Create overlay
          const overlay = document.createElement('div');
          overlay.id = 'claude-test-overlay';

          const defaultWidth = 350;
          const defaultOpacity = 0.95;
          overlay.style.cssText = \`
            position: fixed;
            top: \${prefs.top || '20px'};
            \${prefs.left ? 'left: ' + prefs.left + ';' : 'right: 20px;'}
            width: \${prefs.width || defaultWidth}px;
            \${prefs.height ? 'height: ' + prefs.height + 'px;' : ''}
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 20px;
            border-radius: 12px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.3);
            z-index: 2147483647;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            animation: slideIn 0.3s ease-out;
            cursor: move;
            user-select: none;
            opacity: \${prefs.opacity || defaultOpacity};
            resize: both;
            overflow: auto;
            min-width: 280px;
            max-width: 500px;
          \`;

          // Add animation keyframes
          const style = document.createElement('style');
          style.textContent = \`
            @keyframes slideIn {
              from { transform: translateX(100%); opacity: 0; }
              to { transform: translateX(0); opacity: 1; }
            }
          \`;
          document.head.appendChild(style);

          // Make draggable
          let isDragging = false;
          let isResizing = false;
          let dragOffsetX = 0;
          let dragOffsetY = 0;
          const RESIZE_HANDLE_SIZE = 25;

          function isInResizeHandle(e) {
            const rect = overlay.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            return (rect.width - x < RESIZE_HANDLE_SIZE) && (rect.height - y < RESIZE_HANDLE_SIZE);
          }

          overlay.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'BUTTON' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
            if (isInResizeHandle(e)) {
              isResizing = true;
              return;
            }
            isDragging = true;
            dragOffsetX = e.clientX - overlay.offsetLeft;
            dragOffsetY = e.clientY - overlay.offsetTop;
            overlay.style.cursor = 'grabbing';
          });

          document.addEventListener('mousemove', (e) => {
            if (isResizing) return;
            if (!isDragging) return;
            overlay.style.left = (e.clientX - dragOffsetX) + 'px';
            overlay.style.top = (e.clientY - dragOffsetY) + 'px';
            overlay.style.right = 'auto';
          });

          document.addEventListener('mouseup', () => {
            if (isDragging) {
              isDragging = false;
              overlay.style.cursor = 'move';
              savePrefs({ top: overlay.style.top, left: overlay.style.left });
            }
            if (isResizing) {
              isResizing = false;
              savePrefs({ width: overlay.offsetWidth, height: overlay.offsetHeight });
            }
          });

          // Save size on resize
          let lastWidth = overlay.offsetWidth;
          let lastHeight = overlay.offsetHeight;
          let resizeTimeout;
          const resizeObserver = new ResizeObserver(() => {
            const newWidth = overlay.offsetWidth;
            const newHeight = overlay.offsetHeight;
            if (newWidth !== lastWidth || newHeight !== lastHeight) {
              lastWidth = newWidth;
              lastHeight = newHeight;
              clearTimeout(resizeTimeout);
              resizeTimeout = setTimeout(() => {
                savePrefs({ width: newWidth, height: newHeight });
              }, 100);
            }
          });
          resizeObserver.observe(overlay);

          // Header with opacity slider
          const header = document.createElement('div');
          header.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;';

          const title = document.createElement('div');
          title.style.cssText = 'font-size: 14px; font-weight: 600; opacity: 0.9;';
          title.textContent = 'Ready to Test';

          const opacityControl = document.createElement('div');
          opacityControl.style.cssText = 'display: flex; align-items: center; gap: 6px;';

          const opacitySlider = document.createElement('input');
          opacitySlider.type = 'range';
          opacitySlider.min = '0.3';
          opacitySlider.max = '1';
          opacitySlider.step = '0.05';
          opacitySlider.value = prefs.opacity || defaultOpacity;
          opacitySlider.style.cssText = 'width: 60px; cursor: pointer;';
          opacitySlider.title = 'Opacity';
          opacitySlider.addEventListener('input', () => {
            overlay.style.opacity = opacitySlider.value;
            savePrefs({ opacity: opacitySlider.value });
          });

          const closeBtn = document.createElement('button');
          closeBtn.textContent = 'x';
          closeBtn.style.cssText = \`
            background: rgba(255,255,255,0.2);
            border: none;
            color: white;
            width: 24px;
            height: 24px;
            border-radius: 50%;
            cursor: pointer;
            font-size: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
          \`;
          closeBtn.onclick = () => overlay.remove();

          opacityControl.appendChild(opacitySlider);
          opacityControl.appendChild(closeBtn);

          header.appendChild(title);
          header.appendChild(opacityControl);

          // Feature name
          const feature = document.createElement('div');
          feature.style.cssText = 'font-size: 18px; font-weight: 700; margin-bottom: 12px;';
          feature.textContent = ${JSON.stringify(featureName)};

          // Instructions
          const instDiv = document.createElement('div');
          instDiv.style.cssText = 'font-size: 14px; line-height: 1.6; opacity: 0.95; margin-bottom: 16px;';
          instDiv.innerHTML = ${JSON.stringify(instructionsHtml)};

          // Helper to close this tab
          async function closeThisTab() {
            try {
              const pageId = ${JSON.stringify(page.id)};
              await fetch('http://127.0.0.1:9222/json/close/' + pageId);
            } catch (e) {
              console.log('Could not close tab:', e);
            }
          }

          // Helper to send message to Claude
          async function sendToClaude(msg, button) {
            const sessionId = ${JSON.stringify(sessionId)};
            const originalText = button.innerHTML;
            button.innerHTML = 'Sending...';
            button.disabled = true;

            try {
              if (!sessionId) throw new Error('No session');

              const resp = await fetch('http://localhost:3005/api/sessions/inject-message', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId, message: msg })
              });

              if (!resp.ok) throw new Error('Request failed');

              button.innerHTML = 'Sent!';
              button.style.background = '#16a34a';
              button.style.color = 'white';
              setTimeout(() => closeThisTab(), 600);
              return true;
            } catch (e) {
              try {
                await navigator.clipboard.writeText(msg);
                button.innerHTML = 'Copied!';
                button.style.background = '#f59e0b';
                button.style.color = 'white';
                setTimeout(() => overlay.remove(), 1000);
              } catch (clipErr) {
                button.innerHTML = 'Failed';
                button.style.background = '#dc2626';
                setTimeout(() => { button.innerHTML = originalText; button.disabled = false; }, 2000);
              }
              return false;
            }
          }

          // Works button
          const worksBtn = document.createElement('button');
          worksBtn.innerHTML = 'Works!';
          worksBtn.style.cssText = \`
            width: 100%;
            padding: 12px 16px;
            background: rgba(255,255,255,0.95);
            color: #16a34a;
            border: none;
            border-radius: 8px;
            font-weight: 600;
            font-size: 15px;
            cursor: pointer;
            transition: transform 0.1s;
            margin-bottom: 12px;
          \`;
          worksBtn.onmouseenter = () => worksBtn.style.transform = 'scale(1.02)';
          worksBtn.onmouseleave = () => worksBtn.style.transform = 'scale(1)';
          worksBtn.onclick = () => {
            const msg = ${JSON.stringify(featureName)} + ' works as expected. Mark complete, update plan.md, and move on.';
            sendToClaude(msg, worksBtn);
          };

          // Issue section
          const issueSection = document.createElement('div');
          issueSection.style.cssText = 'border-top: 1px solid rgba(255,255,255,0.2); padding-top: 12px;';

          const issueLabel = document.createElement('div');
          issueLabel.style.cssText = 'font-size: 13px; opacity: 0.8; margin-bottom: 8px;';
          issueLabel.textContent = 'Or describe an issue:';

          const issueInput = document.createElement('textarea');
          issueInput.placeholder = 'Type issue here... (Enter to send, Shift+Enter for newline)';
          issueInput.style.cssText = \`
            width: 100%;
            min-height: 60px;
            padding: 10px;
            border: none;
            border-radius: 8px;
            font-family: inherit;
            font-size: 14px;
            resize: vertical;
            box-sizing: border-box;
            background: rgba(255,255,255,0.95);
            color: #1f2937;
          \`;

          issueInput.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              const issueText = issueInput.value.trim();
              if (!issueText) {
                issueInput.style.border = '2px solid #fca5a5';
                setTimeout(() => issueInput.style.border = 'none', 1000);
                return;
              }
              const msg = 'Issue with ' + ${JSON.stringify(featureName)} + ': ' + issueText;

              const tempBtn = document.createElement('button');
              tempBtn.style.cssText = \`
                width: 100%;
                padding: 10px;
                background: #dc2626;
                color: white;
                border: none;
                border-radius: 8px;
                font-weight: 600;
                margin-top: 8px;
              \`;
              tempBtn.innerHTML = 'Sending...';
              issueInput.parentNode.insertBefore(tempBtn, issueInput.nextSibling);
              issueInput.disabled = true;

              await sendToClaude(msg, tempBtn);
            }
          });

          issueSection.appendChild(issueLabel);
          issueSection.appendChild(issueInput);

          overlay.appendChild(header);
          overlay.appendChild(feature);
          overlay.appendChild(instDiv);
          overlay.appendChild(worksBtn);
          overlay.appendChild(issueSection);
          document.body.appendChild(overlay);

          return 'Overlay injected successfully';
        })();
      `;

      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression: script }
      }));
    });

    ws.on('message', (data) => {
      const response = JSON.parse(data.toString());
      if (response.id === 1) {
        ws.close();
        resolve(response.result);
      }
    });

    ws.on('error', reject);

    setTimeout(() => {
      ws.close();
      reject(new Error('Timeout injecting overlay'));
    }, 5000);
  });
}

/**
 * Activate a tab by page ID
 */
export async function activateTab(page) {
  await fetch(`${CDP_URL}/json/activate/${page.id}`);
}
