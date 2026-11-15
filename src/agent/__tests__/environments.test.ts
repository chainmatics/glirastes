import { describe, expect, it } from 'vitest';
import { environmentBranches, parseEnvironmentList, promotionSource } from '../environments.js';

describe('environmentBranches', () => {
  const remote = async () => ['feature/x', 'dev', 'staging', 'main'];

  it('takes the flag, then the environment variable, then the config, then what origin has', async () => {
    expect(await environmentBranches({ flag: 'qa,uat,prod', env: 'a', config: ['b'], remoteBranches: remote }))
      .toEqual({ branches: ['qa', 'uat', 'prod'], source: 'flag' });
    expect(await environmentBranches({ env: ' pre-dev, dev ,staging,master ', config: ['b'], remoteBranches: remote }))
      .toEqual({ branches: ['pre-dev', 'dev', 'staging', 'master'], source: 'env' });
    expect(await environmentBranches({ env: '', config: ['qa', 'prod'], remoteBranches: remote }))
      .toEqual({ branches: ['qa', 'prod'], source: 'config' });
    expect(await environmentBranches({ remoteBranches: remote })).toEqual({ branches: ['dev', 'staging', 'main'], source: 'detected' });
    expect(await environmentBranches({ remoteBranches: async () => undefined })).toEqual({ branches: [], source: 'detected' });
  });

  it('ignores a list with a name git would not accept', () => {
    expect(parseEnvironmentList('dev,../main')).toBeUndefined();
    expect(parseEnvironmentList(' , ')).toBeUndefined();
  });
});

describe('promotionSource', () => {
  /** Which environments hold the head commit. */
  const holding = (...environments: string[]) => async (environment: string) => environments.includes(environment);

  it('names every hop of any chain a promotion, by its head branch', async () => {
    for (const chain of [['pre-dev', 'dev', 'staging', 'master'], ['qa', 'uat', 'prod']]) {
      for (let index = 0; index + 1 < chain.length; index += 1) {
        const [head, base] = [chain[index]!, chain[index + 1]!];
        expect(await promotionSource({ head, base, environments: chain, containedIn: holding() })).toBe(head);
      }
    }
  });

  it('names a branch whose commit another environment holds, never the target itself', async () => {
    const chain = ['pre-dev', 'dev', 'staging', 'master'];
    expect(await promotionSource({ head: 'release/2.0', base: 'master', environments: chain, containedIn: holding('staging', 'master') }))
      .toBe('staging');
    // A feature branch with nothing new but already in its target is no promotion.
    expect(await promotionSource({ head: 'feature/x', base: 'dev', environments: chain, containedIn: holding('dev') })).toBeUndefined();
    // A push to an environment that a lower one already holds.
    expect(await promotionSource({ head: 'staging', base: 'staging', environments: chain, containedIn: holding('dev') })).toBe('dev');
  });

  it('lets hotfixes into the middle and the top and features into the only environment through', async () => {
    const chain = ['pre-dev', 'dev', 'staging', 'master'];
    expect(await promotionSource({ head: 'hotfix/a', base: 'dev', environments: chain, containedIn: holding() })).toBeUndefined();
    expect(await promotionSource({ head: 'hotfix/b', base: 'master', environments: chain, containedIn: holding() })).toBeUndefined();
    expect(await promotionSource({ head: 'feature/c', base: 'main', environments: ['main'], containedIn: holding() })).toBeUndefined();
    // Containment git cannot decide is no promotion; the content check still holds.
    expect(await promotionSource({ head: 'feature/d', base: 'dev', environments: chain, containedIn: async () => undefined })).toBeUndefined();
  });
});
