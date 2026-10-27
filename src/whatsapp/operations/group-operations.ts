import { isJidGroup, ParticipantAction } from 'athanasia-baileys';
import { SessionManager } from '../session-manager';
import { GroupSummary } from '../connection-manager';
import { AuditRepository } from '../../database/repositories/audit-repository';
import {
  validateGroupInviteLink,
  normalizePhoneNumber,
  OperationRateLimiter,
} from '../../security/validation';
import { UnsupportedOperationError, ValidationError } from '../../utils/errors';

export type GroupManagementActionType =
  | 'ADD_PARTICIPANT'
  | 'REMOVE_PARTICIPANT'
  | 'PROMOTE_PARTICIPANT'
  | 'DEMOTE_PARTICIPANT'
  | 'LEAVE_GROUP'
  | 'GET_INVITE_LINK';

export class GroupOperations {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly auditRepo: AuditRepository,
    private readonly rateLimiter: OperationRateLimiter
  ) {}

  public async listGroups(sessionId: string): Promise<GroupSummary[]> {
    const driver = this.sessionManager.getDriver(sessionId);
    return driver.listParticipatingGroups();
  }

  public async getGroupDetails(sessionId: string, groupJid: string): Promise<GroupSummary> {
    if (!isJidGroup(groupJid) && !groupJid.endsWith('@g.us')) {
      throw new ValidationError('معرف المجموعة غير صالح.');
    }
    const driver = this.sessionManager.getDriver(sessionId);
    return driver.getGroupMetadata(groupJid);
  }

  public async joinGroupForSession(params: {
    sessionId: string;
    inviteLink: string;
    actorTelegramId: number;
  }): Promise<string> {
    const { inviteCode, normalizedUrl } = validateGroupInviteLink(params.inviteLink);
    this.rateLimiter.checkRateLimit(`join_group:${params.sessionId}`);

    const driver = this.sessionManager.getDriver(params.sessionId);
    const joinedGroupJid = await driver.acceptGroupInvite(inviteCode);

    this.auditRepo.record({
      actorTelegramId: params.actorTelegramId,
      action: 'GROUP_JOINED',
      targetId: joinedGroupJid,
      outcome: 'SUCCESS',
      metadata: { sessionId: params.sessionId, inviteUrl: normalizedUrl },
    });

    return `تم الانضمام للمجموعة بنجاح (معرف المجموعة: ${joinedGroupJid})`;
  }

  public async executeAdminGroupAction(params: {
    sessionId: string;
    groupJid: string;
    action: GroupManagementActionType;
    targetPhone?: string;
    actorTelegramId: number;
  }): Promise<string> {
    const { sessionId, groupJid, action, targetPhone, actorTelegramId } = params;
    this.rateLimiter.checkRateLimit(`group_action:${sessionId}`);

    const driver = this.sessionManager.getDriver(sessionId);
    const group = await driver.getGroupMetadata(groupJid);

    if (action === 'LEAVE_GROUP') {
      await driver.leaveGroup(groupJid);
      this.auditRepo.record({
        actorTelegramId,
        action: 'GROUP_LEFT',
        targetId: groupJid,
        outcome: 'SUCCESS',
        metadata: { sessionId, subject: group.subject },
      });
      return `تمت مغادرة المجموعة "${group.subject}" بنجاح.`;
    }

    // All remaining actions require administrative permission in the group
    if (!group.isBotAdmin) {
      this.auditRepo.record({
        actorTelegramId,
        action: `GROUP_${action}`,
        targetId: groupJid,
        outcome: 'DENIED',
        metadata: { sessionId, reason: 'NOT_GROUP_ADMIN' },
      });
      throw new UnsupportedOperationError(
        `لا يملك الحساب صلاحية مشرف (Admin) في المجموعة "${group.subject}" لتنفيذ هذه العملية.`
      );
    }

    if (action === 'GET_INVITE_LINK') {
      const code = await driver.getGroupInviteCode(groupJid);
      this.auditRepo.record({
        actorTelegramId,
        action: 'GROUP_INVITE_GENERATED',
        targetId: groupJid,
        outcome: 'SUCCESS',
        metadata: { sessionId },
      });
      return `رابط دعوة المجموعة "${group.subject}": https://chat.whatsapp.com/${code}`;
    }

    if (!targetPhone) {
      throw new ValidationError('الرجاء إدخال رقم هاتف العضو المستهدف مع رمز الدولة.');
    }

    const normalizedParticipant = normalizePhoneNumber(targetPhone);
    const actionMap: Record<
      Exclude<GroupManagementActionType, 'LEAVE_GROUP' | 'GET_INVITE_LINK'>,
      ParticipantAction
    > = {
      ADD_PARTICIPANT: 'add',
      REMOVE_PARTICIPANT: 'remove',
      PROMOTE_PARTICIPANT: 'promote',
      DEMOTE_PARTICIPANT: 'demote',
    };

    const baileysAction = actionMap[action];
    await driver.updateGroupParticipants(groupJid, [normalizedParticipant.jid], baileysAction);

    this.auditRepo.record({
      actorTelegramId,
      action: `GROUP_${action}`,
      targetId: groupJid,
      outcome: 'SUCCESS',
      metadata: {
        sessionId,
        participantMasked: normalizedParticipant.masked,
      },
    });

    const arabicLabels: Record<ParticipantAction, string> = {
      add: 'إضافة العضو',
      remove: 'إزالة العضو',
      promote: 'ترقية العضو إلى مشرف',
      demote: 'إلغاء إشراف العضو',
    };

    return `تم تنفيذ (${arabicLabels[baileysAction]}) للرقم ${normalizedParticipant.masked} في "${group.subject}".`;
  }
}
