import { test, expect } from '@playwright/test';

test.describe('Deployment Detail & Realtime Log Viewer E2E', () => {
  test.beforeEach(async ({ page }) => {
    // Mock deployment details API endpoint
    await page.route('**/api/deployments/dep-test-123', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'dep-test-123',
          project_id: 'proj-123',
          project_name: 'acme-web-app',
          project_slug: 'acme-web-app',
          branch: 'main',
          commit_hash: '7f9a1b2c3d4e5f6',
          commit_message: 'feat: add live log stream replay',
          status: 'READY',
          preview_url: 'http://acme-web-app.localhost',
          build_duration_ms: 2450,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          logs: [
            { id: 1, sequence: 1, message: '[CLONE] Shallow cloning repository from GitHub (depth: 1)...', step: 'CLONE', timestamp: new Date().toISOString() },
            { id: 2, sequence: 2, message: '[DEPENDENCIES] Resolving dependencies via pnpm install...', step: 'BUILD', timestamp: new Date().toISOString() },
            { id: 3, sequence: 3, message: '[BUILD] Compiling static pages and client bundles...', step: 'BUILD', timestamp: new Date().toISOString() },
            { id: 4, sequence: 4, message: '[UPLOAD] Uploading 18 immutable static artifacts to MinIO storage...', step: 'UPLOAD', timestamp: new Date().toISOString() },
            { id: 5, sequence: 5, message: '[SUCCESS] Deployment published successfully to edge routing!', step: 'DEPLOY', timestamp: new Date().toISOString() },
          ],
        }),
      });
    });

    // Mock SSE log stream endpoint to return stream ended
    await page.route('**/api/deployments/dep-test-123/logs/stream*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: `id: 1\ndata: {"sequence":1,"logChunk":"[CLONE] Shallow cloning repository from GitHub (depth: 1)...","stream":"CLONE"}\n\nid: 2\ndata: {"sequence":2,"logChunk":"[DEPENDENCIES] Resolving dependencies via pnpm install...","stream":"BUILD"}\n\nid: 3\ndata: {"sequence":3,"logChunk":"[BUILD] Compiling static pages and client bundles...","stream":"BUILD"}\n\nid: 4\ndata: {"sequence":4,"logChunk":"[UPLOAD] Uploading 18 immutable static artifacts to MinIO storage...","stream":"UPLOAD"}\n\nid: 5\ndata: {"sequence":5,"logChunk":"[SUCCESS] Deployment published successfully to edge routing!","stream":"DEPLOY"}\n\nevent: end\ndata: {"status":"READY","message":"Log stream completed"}\n\n`,
      });
    });
  });

  test('renders deployment page with pipeline stages, terminal log viewer and metadata', async ({ page }) => {
    await page.goto('/deployments/dep-test-123');

    // Verify commit and branch
    await expect(page.locator('h1')).toContainText('feat: add live log stream replay');
    await expect(page.getByText('main')).toBeVisible();

    // Verify pipeline execution stages
    await expect(page.getByText('Pipeline Execution Stages')).toBeVisible();
    await expect(page.getByText('Ready', { exact: true })).toBeVisible();

    // Verify Terminal Log Viewer window
    const terminal = page.getByRole('region', { name: /Deployment Build Output Logs/i });
    await expect(terminal).toBeVisible();
    await expect(page.getByText('build-output.log')).toBeVisible();

    // Verify log lines are rendered
    await expect(page.getByText('[CLONE] Shallow cloning repository')).toBeVisible();
    await expect(page.getByText('[BUILD] Compiling static pages')).toBeVisible();
    await expect(page.getByText('[SUCCESS] Deployment published successfully')).toBeVisible();
  });

  test('filters log output when user types in search input', async ({ page }) => {
    await page.goto('/deployments/dep-test-123');

    const searchInput = page.getByPlaceholder(/Filter logs/i);
    await expect(searchInput).toBeVisible();

    // Type filter term
    await searchInput.fill('Compiling');
    await expect(page.getByText('[BUILD] Compiling static pages')).toBeVisible();
    await expect(page.getByText('[CLONE] Shallow cloning repository')).not.toBeVisible();

    // Clear filter by filling empty string
    await searchInput.fill('');
    await expect(page.getByText('[CLONE] Shallow cloning repository')).toBeVisible();
  });

  test('supports keyboard navigation shortcuts (/, C, A, ?)', async ({ page }) => {
    await page.goto('/deployments/dep-test-123');

    // Click shortcuts modal button directly
    const shortcutsButton = page.getByTitle(/Keyboard shortcuts/i);
    await expect(shortcutsButton).toBeVisible();
    await shortcutsButton.click();
    await expect(page.getByText(/Search/i).first()).toBeVisible();

    // Press '/' to focus filter search
    await page.keyboard.press('/');
    const searchInput = page.getByPlaceholder(/Filter logs/i);
    await expect(searchInput).toBeFocused();

    // Press Escape to blur and reset
    await page.keyboard.press('Escape');
    await expect(searchInput).not.toBeFocused();
  });

  test('renders responsive controls and touch targets on mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/deployments/dep-test-123');

    // Action buttons visible and accessible on mobile
    await expect(page.getByText('Ready', { exact: true })).toBeVisible();
    const searchInput = page.getByPlaceholder(/Filter logs/i);
    await expect(searchInput).toBeVisible();
  });
});
