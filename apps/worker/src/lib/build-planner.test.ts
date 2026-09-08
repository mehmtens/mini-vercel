import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { BuildPlanner } from './build-planner';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('BuildPlanner static HTML output', () => {
  it('uses the repository root when no public directory exists', () => {
    const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'doplo-static-root-'));
    temporaryDirectories.push(rootDirectory);
    fs.writeFileSync(path.join(rootDirectory, 'index.html'), '<h1>Static site</h1>');

    const planner = new BuildPlanner();
    const plan = planner.createBuildPlan(rootDirectory);

    expect(plan.framework).toBe('static');
    expect(plan.outputDirectory).toBe('.');
    expect(planner.validateOutputDirectory(rootDirectory, plan.outputDirectory)).toEqual({ artifactCount: 1 });
  });

  it('continues to prefer an explicit public directory', () => {
    const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'doplo-static-public-'));
    temporaryDirectories.push(rootDirectory);
    fs.mkdirSync(path.join(rootDirectory, 'public'));
    fs.writeFileSync(path.join(rootDirectory, 'public', 'index.html'), '<h1>Public site</h1>');

    const planner = new BuildPlanner();
    const plan = planner.createBuildPlan(rootDirectory);

    expect(plan.outputDirectory).toBe('public');
  });
});
