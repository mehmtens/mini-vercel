import fs from 'fs';
import path from 'path';

export class InvalidOutputDirectoryError extends Error {
  constructor(outputDir: string, details?: string) {
    super(
      `ERR_INVALID_OUTPUT_DIRECTORY: Output directory "${outputDir}" does not exist or does not contain any valid build artifacts. ${
        details || ''
      }`
    );
    this.name = 'InvalidOutputDirectoryError';
  }
}

export type SupportedFramework =
  | 'nextjs'
  | 'vite'
  | 'create-react-app'
  | 'astro'
  | 'remix'
  | 'svelte'
  | 'vue'
  | 'static'
  | 'nodejs';

export type SupportedPackageManager = 'pnpm' | 'yarn' | 'npm' | 'bun';

export interface BuildPlan {
  framework: SupportedFramework;
  packageManager: SupportedPackageManager;
  installCommand: string;
  buildCommand: string;
  outputDirectory: string;
  nodeVersion: string;
  env: Record<string, string>;
}

export class BuildPlanner {
  /**
   * Generates a deterministic Nixpacks-style build plan by inspecting the workspace
   */
  public createBuildPlan(
    workspaceDir: string,
    overrides?: {
      installCommand?: string;
      buildCommand?: string;
      outputDirectory?: string;
      rootDirectory?: string;
    }
  ): BuildPlan {
    const rootDir = overrides?.rootDirectory
      ? path.join(workspaceDir, overrides.rootDirectory)
      : workspaceDir;

    const pkgJsonPath = path.join(rootDir, 'package.json');
    let pkgJson: any = null;
    if (fs.existsSync(pkgJsonPath)) {
      try {
        pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
      } catch {}
    }

    const packageManager = this.detectPackageManager(rootDir);
    const framework = this.detectFramework(rootDir, pkgJson);

    // Determine install command
    let installCommand = overrides?.installCommand;
    if (!installCommand) {
      if (packageManager === 'pnpm') {
        installCommand = 'pnpm install --frozen-lockfile';
      } else if (packageManager === 'yarn') {
        installCommand = 'yarn install --frozen-lockfile';
      } else if (fs.existsSync(path.join(rootDir, 'package-lock.json'))) {
        installCommand = 'npm ci';
      } else {
        installCommand = 'npm install --include=dev';
      }
    }

    // Determine build command
    let buildCommand = overrides?.buildCommand;
    if (!buildCommand) {
      if (pkgJson?.scripts?.build) {
        buildCommand = `${packageManager === 'pnpm' ? 'pnpm' : packageManager === 'yarn' ? 'yarn' : 'npm run'} build`;
      } else if (framework === 'static') {
        buildCommand = 'echo "Static build completed"';
      } else {
        buildCommand = 'npm run build';
      }
    }

    // Determine output directory
    let outputDirectory = overrides?.outputDirectory;
    if (!outputDirectory) {
      if (framework === 'nextjs') {
        outputDirectory = fs.existsSync(path.join(rootDir, 'out')) ? 'out' : '.next';
      } else if (framework === 'vite' || framework === 'astro' || framework === 'svelte') {
        outputDirectory = 'dist';
      } else if (framework === 'create-react-app') {
        outputDirectory = 'build';
      } else if (framework === 'remix') {
        outputDirectory = fs.existsSync(path.join(rootDir, 'build/client')) ? 'build/client' : 'public/build';
      } else if (framework === 'static') {
        outputDirectory = fs.existsSync(path.join(rootDir, 'public')) ? 'public' : '.';
      } else {
        outputDirectory = 'dist';
      }
    }

    return {
      framework,
      packageManager,
      installCommand,
      buildCommand,
      outputDirectory,
      nodeVersion: '22',
      env: {
        CI: 'true',
        NODE_ENV: 'production',
      },
    };
  }

  /**
   * Validates that the build output directory exists and contains valid artifact files
   */
  public validateOutputDirectory(workspaceDir: string, outputDirectory: string): { artifactCount: number } {
    const fullOutputPath = path.join(workspaceDir, outputDirectory);

    if (!fs.existsSync(fullOutputPath)) {
      throw new InvalidOutputDirectoryError(
        outputDirectory,
        `Directory path "${fullOutputPath}" does not exist after build completion.`
      );
    }

    const stat = fs.statSync(fullOutputPath);
    if (!stat.isDirectory()) {
      throw new InvalidOutputDirectoryError(
        outputDirectory,
        `Path "${fullOutputPath}" exists but is not a directory.`
      );
    }

    const items = fs.readdirSync(fullOutputPath);
    if (items.length === 0) {
      throw new InvalidOutputDirectoryError(
        outputDirectory,
        `Output directory "${fullOutputPath}" is empty.`
      );
    }

    return { artifactCount: items.length };
  }

  private detectPackageManager(dir: string): SupportedPackageManager {
    if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
    if (fs.existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
    if (fs.existsSync(path.join(dir, 'bun.lockb'))) return 'bun';
    return 'npm';
  }

  private detectFramework(dir: string, pkgJson: any): SupportedFramework {
    const deps = { ...pkgJson?.dependencies, ...pkgJson?.devDependencies };

    if (deps?.next || fs.existsSync(path.join(dir, 'next.config.js')) || fs.existsSync(path.join(dir, 'next.config.mjs'))) {
      return 'nextjs';
    }
    if (deps?.astro || fs.existsSync(path.join(dir, 'astro.config.mjs'))) {
      return 'astro';
    }
    if (deps?.['@remix-run/react'] || fs.existsSync(path.join(dir, 'remix.config.js'))) {
      return 'remix';
    }
    if (deps?.['@sveltejs/kit'] || deps?.svelte) {
      return 'svelte';
    }
    if (deps?.vue || deps?.nuxt) {
      return 'vue';
    }
    if (deps?.vite || fs.existsSync(path.join(dir, 'vite.config.ts')) || fs.existsSync(path.join(dir, 'vite.config.js'))) {
      return 'vite';
    }
    if (deps?.['react-scripts']) {
      return 'create-react-app';
    }
    if (fs.existsSync(path.join(dir, 'index.html')) && !pkgJson?.scripts?.build) {
      return 'static';
    }

    return 'nodejs';
  }
}

export const buildPlanner = new BuildPlanner();
