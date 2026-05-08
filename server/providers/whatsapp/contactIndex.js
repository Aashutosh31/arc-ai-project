const fs = require('fs');
const path = require('path');

const INDEX_DIR = path.resolve(__dirname, '../../.whatsapp-sessions');
const INDEX_FILE = (userId) => path.join(INDEX_DIR, `${String(userId)}.contacts.json`);

const indexes = new Map();

const ensureDir = () => {
    if (!fs.existsSync(INDEX_DIR)) fs.mkdirSync(INDEX_DIR, { recursive: true });
};

const normalizeText = (value) => String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const normalizePhone = (value) => String(value || '').replace(/\D/g, '');

const contactNameTokens = (contact) => {
    const candidates = [
        contact.name,
        contact.pushname,
        contact.shortName,
        contact.formattedName,
        contact.verifiedName,
        contact.notifyName,
        contact.alias
    ];

    return Array.from(new Set(candidates.map(normalizeText).filter(Boolean)));
};

const contactAliases = (contact) => {
    const aliases = [
        contact.name,
        contact.pushname,
        contact.shortName,
        contact.formattedName,
        contact.verifiedName,
        contact.notifyName,
        contact.alias
    ]
        .map(normalizeText)
        .filter(Boolean);

    const phone = normalizePhone(contact.number || contact.id?.user || contact.id?._serialized);
    if (phone) aliases.push(phone);

    return Array.from(new Set(aliases));
};

const toRecord = (contact) => {
    const phone = normalizePhone(contact.number || contact.id?.user || contact.id?._serialized);
    const jid = contact.id?._serialized || (phone ? `${phone}@c.us` : '');
    return {
        name: contact.name || contact.pushname || contact.shortName || contact.formattedName || '',
        jid,
        phone,
        aliases: contactAliases(contact),
        raw: {
            name: contact.name,
            pushname: contact.pushname,
            shortName: contact.shortName,
            formattedName: contact.formattedName,
            verifiedName: contact.verifiedName,
            notifyName: contact.notifyName
        },
        updatedAt: new Date().toISOString()
    };
};

const loadIndex = (userId) => {
    ensureDir();
    if (indexes.has(userId)) return indexes.get(userId);

    const file = INDEX_FILE(userId);
    if (fs.existsSync(file)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
            const normalized = Array.isArray(parsed) ? parsed : [];
            indexes.set(userId, normalized);
            return normalized;
        } catch (error) {
            console.error('[WhatsApp] failed to load contact index:', error?.message || error);
        }
    }

    indexes.set(userId, []);
    return [];
};

const saveIndex = (userId, contacts) => {
    ensureDir();
    indexes.set(userId, contacts);
    try {
        fs.writeFileSync(INDEX_FILE(userId), JSON.stringify(contacts, null, 2));
    } catch (error) {
        console.error('[WhatsApp] failed to save contact index:', error?.message || error);
    }
};

const upsertContacts = (userId, contacts = []) => {
    const existing = loadIndex(userId);
    const map = new Map(existing.map((contact) => [contact.jid, contact]));

    for (const contact of contacts) {
        const record = toRecord(contact);
        if (!record.jid) continue;
        map.set(record.jid, {
            ...(map.get(record.jid) || {}),
            ...record
        });
    }

    const merged = Array.from(map.values());
    saveIndex(userId, merged);
    return merged;
};

const syncContactsFromClient = async (userId, client) => {
    if (!client) throw new Error('WhatsApp client unavailable for contact sync');
    const contacts = await client.getContacts();
    const filtered = (contacts || []).filter((contact) => {
        if (!contact) return false;
        if (contact.isGroup) return false;
        if (contact.isMe) return false;
        return true;
    });

    return upsertContacts(userId, filtered);
};

const searchContacts = (userId, recipientName) => {
    const contacts = loadIndex(userId);
    const query = normalizeText(recipientName);
    if (!query) return [];

    const queryPhone = normalizePhone(recipientName);
    return contacts
        .map((contact) => {
            const haystacks = [
                normalizeText(contact.name),
                ...(contact.aliases || []).map(normalizeText),
                normalizePhone(contact.phone),
                normalizeText(contact.jid)
            ];

            const exactMatch = haystacks.some((value) => value === query);
            const partialMatch = haystacks.some((value) => value.includes(query));
            const phoneMatch = queryPhone && normalizePhone(contact.phone) === queryPhone;
            const aliasMatch = (contact.aliases || []).some((alias) => normalizeText(alias) === query);

            let score = 0;
            if (exactMatch) score += 100;
            if (aliasMatch) score += 90;
            if (phoneMatch) score += 95;
            if (partialMatch) score += 60;
            if (normalizeText(contact.name).startsWith(query)) score += 15;

            return { contact, score };
        })
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((entry) => entry.contact);
};

const resolveRecipient = (userId, recipientName) => {
    const matches = searchContacts(userId, recipientName);
    if (matches.length === 0) {
        return { status: 'not_found', matches: [] };
    }

    if (matches.length === 1) {
        return { status: 'resolved', contact: matches[0], matches };
    }

    return { status: 'ambiguous', matches };
};

module.exports = {
    loadIndex,
    upsertContacts,
    syncContactsFromClient,
    searchContacts,
    resolveRecipient
};
