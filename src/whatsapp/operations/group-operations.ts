import { isJidGroup, ParticipantAction } from '../baileys-compat';
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
  | 'GET_INVITE_LINK'
  | 'REVOKE_INVITE_LINK'
  | 'UPDATE_SUBJECT'
  | 'UPDATE_DESCRIPTION'
  | 'SET_ANNOUNCEMENT'
  | 'SET_NOT_ANNOUNCEMENT'
  | 'TOGGLE_EPHEMERAL'
  | 'APPROVE_ALL_JOIN_REQUESTS'
  | 'REJECT_ALL_JOIN_REQUESTS'
  | 'SEND_HIDETAG';

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

  public async inspectInviteLink(
    sessionId: string,
    inviteLink: string
  ): Promise<{
    id: string;
    subject: string;
    size: number;
    owner?: string;
    creation?: number;
    desc?: string;
  } | null> {
    const { inviteCode } = validateGroupInviteLink(inviteLink);
    const driver = this.sessionManager.getDriver(sessionId);
    if (typeof driver.inspectGroupInvite !== 'function') {
      return null;
    }
    try {
      return await driver.inspectGroupInvite(inviteCode);
    } catch {
      return null;
    }
  }

  public async createGroupForSession(params: {
    sessionId: string;
    subject: string;
    participantPhones: string[];
    actorTelegramId: number;
  }): Promise<GroupSummary> {
    const cleanSubject = params.subject.trim();
    if (!cleanSubject || cleanSubject.length > 100) {
      throw new ValidationError('الرجاء إدخال عنوان صالح للمجموعة (1 إلى 100 حرف).');
    }
    this.rateLimiter.checkRateLimit(`create_group:${params.sessionId}`);
    const participantJids = params.participantPhones
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => normalizePhoneNumber(p).jid);

    const driver = this.sessionManager.getDriver(params.sessionId);
    if (typeof driver.createGroup !== 'function') {
      throw new UnsupportedOperationError('إنشاء المجموعات غير مدعوم على هذا المحرك.');
    }
    const created = await driver.createGroup(cleanSubject, participantJids);
    this.auditRepo.record({
      actorTelegramId: params.actorTelegramId,
      action: 'GROUP_CREATED',
      targetId: created.jid,
      outcome: 'SUCCESS',
      metadata: {
        sessionId: params.sessionId,
        subject: created.subject,
        participantsCount: participantJids.length,
      },
    });
    return created;
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
    textPayload?: string;
    actorTelegramId: number;
  }): Promise<string> {
    const { sessionId, groupJid, action, targetPhone, textPayload, actorTelegramId } = params;
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

    if (action === 'SEND_HIDETAG') {
      const broadcastText = (textPayload || targetPhone || '').trim();
      if (!broadcastText) {
        throw new ValidationError('الرجاء إدخال نص الإشعار الجماعي المخفي (Hidetag).');
      }
      if (typeof driver.sendGroupHidetagMessage !== 'function') {
        throw new UnsupportedOperationError('الإشارة الجماعية المخفية غير مدعومة.');
      }
      const { messageId, mentionedCount } = await driver.sendGroupHidetagMessage(
        groupJid,
        broadcastText
      );
      this.auditRepo.record({
        actorTelegramId,
        action: 'GROUP_HIDETAG_SENT',
        targetId: groupJid,
        outcome: 'SUCCESS',
        metadata: { sessionId, mentionedCount, messageId },
      });
      return `تم إرسال الإشعار الجماعي المخفي (Hidetag) إلى ${mentionedCount} عضو في "${group.subject}" (معرف: ${messageId}).`;
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

    if (action === 'REVOKE_INVITE_LINK') {
      if (typeof driver.revokeGroupInvite !== 'function') {
        throw new UnsupportedOperationError('إلغاء رابط الدعوة غير مدعوم.');
      }
      const newCode = await driver.revokeGroupInvite(groupJid);
      this.auditRepo.record({
        actorTelegramId,
        action: 'GROUP_INVITE_REVOKED',
        targetId: groupJid,
        outcome: 'SUCCESS',
        metadata: { sessionId },
      });
      return `تم إلغاء الرابط السابق وتوليد رابط جديد للمجموعة "${group.subject}": https://chat.whatsapp.com/${newCode}`;
    }

    if (action === 'UPDATE_SUBJECT') {
      const newSubject = (textPayload || targetPhone || '').trim();
      if (!newSubject || newSubject.length > 100) {
        throw new ValidationError('الرجاء إدخال عنوان صالح للمجموعة (1-100 حرف).');
      }
      if (typeof driver.updateGroupSubject !== 'function') {
        throw new UnsupportedOperationError('تعديل عنوان المجموعة غير مدعوم.');
      }
      await driver.updateGroupSubject(groupJid, newSubject);
      this.auditRepo.record({
        actorTelegramId,
        action: 'GROUP_SUBJECT_UPDATED',
        targetId: groupJid,
        outcome: 'SUCCESS',
        metadata: { sessionId, newSubject },
      });
      return `تم تحديث اسم المجموعة إلى "${newSubject}" بنجاح.`;
    }

    if (action === 'UPDATE_DESCRIPTION') {
      const newDesc = (textPayload || targetPhone || '').trim();
      if (typeof driver.updateGroupDescription !== 'function') {
        throw new UnsupportedOperationError('تعديل وصف المجموعة غير مدعوم.');
      }
      await driver.updateGroupDescription(groupJid, newDesc);
      this.auditRepo.record({
        actorTelegramId,
        action: 'GROUP_DESC_UPDATED',
        targetId: groupJid,
        outcome: 'SUCCESS',
        metadata: { sessionId },
      });
      return `تم تحديث وصف المجموعة "${group.subject}" بنجاح.`;
    }

    if (action === 'SET_ANNOUNCEMENT' || action === 'SET_NOT_ANNOUNCEMENT') {
      if (typeof driver.updateGroupSetting !== 'function') {
        throw new UnsupportedOperationError('تعديل إعدادات المجموعة غير مدعوم.');
      }
      const setting = action === 'SET_ANNOUNCEMENT' ? 'announcement' : 'not_announcement';
      await driver.updateGroupSetting(groupJid, setting);
      this.auditRepo.record({
        actorTelegramId,
        action: `GROUP_${action}`,
        targetId: groupJid,
        outcome: 'SUCCESS',
        metadata: { sessionId, setting },
      });
      return action === 'SET_ANNOUNCEMENT'
        ? `تم قفل المحادثة في "${group.subject}" (الإرسال للمشرفين فقط).`
        : `تم فتح المحادثة في "${group.subject}" (الإرسال متاح لجميع الأعضاء).`;
    }

    if (action === 'TOGGLE_EPHEMERAL') {
      if (typeof driver.toggleGroupEphemeral !== 'function') {
        throw new UnsupportedOperationError('تعديل الرسائل المؤقتة غير مدعوم.');
      }
      const rawSec = Number((textPayload || targetPhone || '86400').trim());
      const allowed = [0, 86400, 604800, 7776000];
      const seconds = allowed.includes(rawSec) ? rawSec : 86400;
      await driver.toggleGroupEphemeral(groupJid, seconds);
      this.auditRepo.record({
        actorTelegramId,
        action: 'GROUP_EPHEMERAL_UPDATED',
        targetId: groupJid,
        outcome: 'SUCCESS',
        metadata: { sessionId, seconds },
      });
      return seconds === 0
        ? `تم إيقاف الرسائل المؤقتة في المجموعة "${group.subject}".`
        : `تم تفعيل الرسائل المؤقتة (${seconds} ثانية) في المجموعة "${group.subject}".`;
    }

    if (
      action === 'APPROVE_ALL_JOIN_REQUESTS' ||
      action === 'REJECT_ALL_JOIN_REQUESTS'
    ) {
      if (
        typeof driver.listGroupJoinRequests !== 'function' ||
        typeof driver.updateGroupJoinRequests !== 'function'
      ) {
        throw new UnsupportedOperationError('إدارة طلبات الانضمام غير مدعومة.');
      }
      const pending = await driver.listGroupJoinRequests(groupJid);
      if (pending.length === 0) {
        return `لا توجد طلبات انضمام معلقة حالياً في المجموعة "${group.subject}".`;
      }
      const jids = pending.map((p) => p.jid);
      const decision = action === 'APPROVE_ALL_JOIN_REQUESTS' ? 'approve' : 'reject';
      await driver.updateGroupJoinRequests(groupJid, jids, decision);
      this.auditRepo.record({
        actorTelegramId,
        action: `GROUP_${action}`,
        targetId: groupJid,
        outcome: 'SUCCESS',
        metadata: { sessionId, count: jids.length },
      });
      return decision === 'approve'
        ? `تم قبول ${jids.length} طلب انضمام معلق في المجموعة "${group.subject}".`
        : `تم رفض ${jids.length} طلب انضمام معلق في المجموعة "${group.subject}".`;
    }

    if (!targetPhone) {
      throw new ValidationError('الرجاء إدخال رقم هاتف العضو المستهدف مع رمز الدولة.');
    }

    const normalizedParticipant = normalizePhoneNumber(targetPhone);
    const actionMap: Record<
      'ADD_PARTICIPANT' | 'REMOVE_PARTICIPANT' | 'PROMOTE_PARTICIPANT' | 'DEMOTE_PARTICIPANT',
      ParticipantAction
    > = {
      ADD_PARTICIPANT: 'add',
      REMOVE_PARTICIPANT: 'remove',
      PROMOTE_PARTICIPANT: 'promote',
      DEMOTE_PARTICIPANT: 'demote',
    };

    const baileysAction = actionMap[
      action as 'ADD_PARTICIPANT' | 'REMOVE_PARTICIPANT' | 'PROMOTE_PARTICIPANT' | 'DEMOTE_PARTICIPANT'
    ];
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
