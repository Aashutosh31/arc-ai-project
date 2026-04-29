const User = require('../models/User');
const GuestSession = require('../models/GuestSession');

const isGuestActorId = (actorId) => String(actorId || '').startsWith('guest_');

const getActorRecord = async (actorId) => {
    if (!actorId) return null;

    if (isGuestActorId(actorId)) {
        return GuestSession.findOne({ sessionId: String(actorId) });
    }

    return User.findById(actorId);
};

const getCreditsRemaining = async (actorId) => {
    const record = await getActorRecord(actorId);
    if (!record) return null;

    return Number(record.creditsRemaining || 0);
};

const consumeCredits = async (actorId, amount = 1, reason = 'usage') => {
    const normalizedAmount = Math.max(1, Number(amount || 1));
    const record = await getActorRecord(actorId);

    if (!record) {
      return { success: false, error: 'Account not found for credit check.' };
    }

    const current = Number(record.creditsRemaining || 0);
    if (current < normalizedAmount) {
        return {
            success: false,
            error: `You are out of credits. ${reason ? `This action requires ${normalizedAmount} credit(s) for ${reason}. ` : ''}Please sign in or upgrade your account to continue.`,
            creditsRemaining: current
        };
    }

    record.creditsRemaining = current - normalizedAmount;
    if (record.lastActiveAt !== undefined) {
        record.lastActiveAt = new Date();
    }

    await record.save();

    return {
        success: true,
        creditsRemaining: record.creditsRemaining,
        consumed: normalizedAmount
    };
};

module.exports = {
    consumeCredits,
    getCreditsRemaining,
    getActorRecord,
    isGuestActorId
};