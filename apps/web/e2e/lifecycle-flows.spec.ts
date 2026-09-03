import { test, expect } from '@playwright/test';

test.describe('Platform Lifecycle & Deployment State Machine E2E', () => {
  test('1. Failed build display: renders build failure state and error diagnostic banner', async ({ page }) => {
    await page.route('**/api/deployments/dep-failed-456', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'dep-failed-456',
          project_id: 'proj-123',
          project_name: 'acme-web-app',
          project_slug: 'acme-web-app',
          branch: 'main',
          commit_hash: '9a8b7c6d5e4f3a2',
          commit_message: 'fix: broken typescript syntax',
          status: 'FAILED',
          error_message: 'Type error: Property "render" does not exist on type "Widget"',
          build_duration_ms: 3200,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          logs: [
            { id: 1, sequence: 1, message: '[CLONE] Repository cloned successfully.', step: 'CLONE', timestamp: new Date().toISOString() },
            { id: 2, sequence: 2, message: '[BUILD] Running build command: npm run build', step: 'BUILD', timestamp: new Date().toISOString() },
            { id: 3, sequence: 3, message: 'src/main.ts:14:5 - error TS2339: Property "render" does not exist', step: 'BUILD', timestamp: new Date().toISOString() },
            { id: 4, sequence: 4, message: '[ERROR] Build exited with code 1', step: 'BUILD', timestamp: new Date().toISOString() },
          ],
        }),
      });
    });

    await page.route('**/api/deployments/dep-failed-456/logs/stream*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: `id: 1\ndata: {"sequence":1,"logChunk":"[ERROR] Build exited with code 1"}\n\nevent: end\ndata: {"status":"FAILED"}\n\n`,
      });
    });

    await page.goto('/deployments/dep-failed-456');

    // Verify commit and failed status badge
    await expect(page.locator('h1')).toContainText('fix: broken typescript syntax');
    await expect(page.getByText(/Failed/i).first()).toBeVisible();

    // Verify error banner is visible with failure diagnostics
    await expect(page.getByText('Type error: Property "render" does not exist on type "Widget"')).toBeVisible();
  });

  test('2. Cancel in-flight build: shows cancel button and triggers cancel API request', async ({ page }) => {
    let cancelApiCalled = false;

    page.on('dialog', async (dialog) => {
      await dialog.accept();
    });

    await page.route('**/api/deployments/dep-building-789', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'dep-building-789',
          project_id: 'proj-123',
          project_name: 'acme-web-app',
          project_slug: 'acme-web-app',
          branch: 'main',
          commit_hash: '1234567890abcdef',
          commit_message: 'chore: long running build',
          status: 'BUILDING',
          build_duration_ms: 5000,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          logs: [
            { id: 1, sequence: 1, message: '[BUILD] Compiling large asset bundles...', step: 'BUILD', timestamp: new Date().toISOString() },
          ],
        }),
      });
    });

    await page.route('**/api/deployments/dep-building-789/logs/stream*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: `id: 1\ndata: {"sequence":1,"logChunk":"[BUILD] Compiling large asset bundles..."}\n\n`,
      });
    });

    await page.route('**/api/deployments/dep-building-789/cancel', async (route) => {
      cancelApiCalled = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, status: 'CANCELLED' }),
      });
    });

    await page.goto('/deployments/dep-building-789');

    // Verify building state
    await expect(page.getByText('Building').first()).toBeVisible();

    // Verify Cancel Build button is present and click it
    const cancelButton = page.getByRole('button', { name: /Cancel Build/i });
    await expect(cancelButton).toBeVisible();
    await cancelButton.click();
    expect(cancelApiCalled).toBe(true);
  });

  test('3. Project management: project page displays deployment list and metadata', async ({ page }) => {
    await page.route('**/api/projects/proj-123', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            id: 'proj-123',
            name: 'acme-web-app',
            slug: 'acme-web-app',
            repoUrl: 'https://github.com/doplo/acme-web-app',
            framework: 'nextjs',
            branch: 'main',
            currentDeploymentId: 'dep-prod-1',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        }),
      });
    });

    await page.route('**/api/deployments*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          deployments: [
            {
              id: 'dep-prod-1',
              project_id: 'proj-123',
              project_name: 'acme-web-app',
              project_slug: 'acme-web-app',
              commit_hash: '1111111',
              commit_message: 'feat: production v1',
              status: 'READY',
              branch: 'main',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
            {
              id: 'dep-prev-2',
              project_id: 'proj-123',
              project_name: 'acme-web-app',
              project_slug: 'acme-web-app',
              commit_hash: '2222222',
              commit_message: 'feat: preview feature',
              status: 'READY',
              branch: 'feature-x',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
        }),
      });
    });

    await page.route('**/api/projects/proj-123/env*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: [],
        }),
      });
    });

    await page.goto('/projects/proj-123');

    // Verify project title and deployments list
    await expect(page.locator('h1')).toContainText('acme-web-app');
    await expect(page.getByText('feat: production v1')).toBeVisible();
    await expect(page.getByText('feat: preview feature')).toBeVisible();
  });
});
