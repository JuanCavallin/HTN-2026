import { Router } from 'express';
import { approvalDecisionSchema, type ApprovalDecision } from '@htn/shared';
import { decideApproval, getApproval } from '../services/approvals.service.js';
import { HttpError, param, valid, validate } from './middleware/validate.js';

export const approvalsRouter: Router = Router();

approvalsRouter.get('/approvals/:id', async (req, res) => {
  const approval = await getApproval(param(req, 'id'));
  if (!approval) throw new HttpError(404, 'NOT_FOUND', 'Approval not found');
  res.json({ approval });
});

/**
 * The human half of the risk gate. This is what unblocks a run that stopped
 * before an irreversible action: approve it, reject it, or revise the exact
 * payload (which is reauthorized in the service before anything runs).
 */
approvalsRouter.post(
  '/approvals/:id/decide',
  validate(approvalDecisionSchema),
  async (req, res) => {
    const body = valid<ApprovalDecision>(req, 'body');
    const approval = await decideApproval(param(req, 'id'), body);
    res.json({ approval });
  },
);
