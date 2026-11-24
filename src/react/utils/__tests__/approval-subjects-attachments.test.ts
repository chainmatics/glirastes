import { describe, expect, it } from 'vitest';
import { resolveApprovalSubjects } from '../approval-subjects.js';
import { collectEntitySightings } from '../entity-names.js';

const ATT = 'att_9bba5153977143159fdcce70798e9a96';
const TASK = '3f1d2c4b-5a6e-4f70-8a91-b2c3d4e5f607';
const file = { type: 'file', mediaType: 'application/pdf', filename: 'Angebot.pdf', url: '', providerMetadata: { glirastes: { attachmentId: ATT } } };

describe('chat attachments on the approval card', () => {
  it('names an attachment id by the file the user attached', () => {
    const seen = collectEntitySightings([{ role: 'user', parts: [{ type: 'text', text: 'Häng das an' }, file] }]);
    expect(resolveApprovalSubjects({ taskId: TASK, attachmentId: ATT }, seen)).toContainEqual(
      expect.objectContaining({ path: 'attachmentId', id: ATT, status: 'named', name: 'Angebot.pdf' }),
    );
  });

  it('names it from the placeholder text of a file whose data was dropped', () => {
    const seen = collectEntitySightings([{ role: 'user', parts: [{ type: 'text', text: `[attachment ${ATT}: Angebot.pdf]` }] }]);
    expect(resolveApprovalSubjects({ attachmentId: ATT }, seen)[0]).toMatchObject({ status: 'named', name: 'Angebot.pdf' });
  });

  it('keeps an attachment id unknown when only the assistant wrote it', () => {
    const seen = collectEntitySightings([{ role: 'assistant', parts: [{ type: 'text', text: `[attachment ${ATT}: Angebot.pdf]` }, file] }]);
    expect(resolveApprovalSubjects({ attachmentId: ATT }, seen)[0]).toMatchObject({ status: 'unknown' });
  });
});
