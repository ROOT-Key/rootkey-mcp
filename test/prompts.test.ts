import { describe, expect, it } from 'vitest';
import { connectTestClient, testConfig } from './helpers.js';

describe('prompts', () => {
  it('offers the four workflows, and declares the prompts capability', async () => {
    const { client, close } = await connectTestClient();
    try {
      const { prompts } = await client.listPrompts();

      expect(prompts.map((prompt) => prompt.name).sort()).toEqual([
        'anchor_folder',
        'backup_workspace',
        'compliance_evidence_pack',
        'verify_local_copies',
      ]);

      for (const prompt of prompts) {
        expect(prompt.description, `${prompt.name} needs a description`).toBeTruthy();
      }
    } finally {
      await close();
    }
  });

  // A read-only server must not offer a workflow it would refuse to finish.
  it('hides the writing workflows in read-only mode', async () => {
    const { client, close } = await connectTestClient(testConfig({ readOnly: true }));
    try {
      const { prompts } = await client.listPrompts();
      expect(prompts.map((prompt) => prompt.name)).toEqual(['compliance_evidence_pack']);
    } finally {
      await close();
    }
  });

  it('substitutes the arguments into the message', async () => {
    const { client, close } = await connectTestClient();
    try {
      const result = await client.getPrompt({
        name: 'anchor_folder',
        arguments: { folderPath: '/tmp/contracts', vaultAddress: '0xdf67' },
      });

      const first = result.messages[0];
      expect(first?.role).toBe('user');
      const text = first?.content.type === 'text' ? first.content.text : '';
      expect(text).toContain('/tmp/contracts');
      expect(text).toContain('0xdf67');
      expect(text).toContain('rootkey_upload_file');
    } finally {
      await close();
    }
  });

  it('keeps the password caveat inside the backup workflow', async () => {
    const { client, close } = await connectTestClient();
    try {
      const result = await client.getPrompt({ name: 'backup_workspace', arguments: { name: 'nightly' } });
      const first = result.messages[0];
      const text = first?.content.type === 'text' ? first.content.text : '';

      expect(text).toContain('rootkey_wait_for_recovery_point');
      expect(text).toContain('shown once');
      expect(text).toContain('Do not repeat the password');
    } finally {
      await close();
    }
  });
});
