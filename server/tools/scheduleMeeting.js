const { google } = require('googleapis');
const { getAuthorizedOAuthClient } = require('../services/googleCalendarService');

const normalizeAttendees = (attendees) => {
    if (!attendees) return [];
    if (Array.isArray(attendees)) {
        return attendees
            .map((value) => String(value).trim())
            .filter(Boolean)
            .map((email) => ({ email }));
    }

    return String(attendees)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
        .map((email) => ({ email }));
};

const toIsoDate = (value, label) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        throw new Error(`Invalid ${label} supplied to scheduleMeeting.`);
    }
    return date.toISOString();
};

module.exports = {
    schema: {
        type: 'function',
        function: {
            name: 'scheduleMeeting',
            description: 'Schedule a new meeting on the user\'s Google Calendar. Use this when the user asks to book or create an event.',
            parameters: {
                type: 'object',
                properties: {
                    summary: {
                        type: 'string',
                        description: 'Meeting title or summary.'
                    },
                    description: {
                        type: 'string',
                        description: 'Optional meeting description or agenda.'
                    },
                    location: {
                        type: 'string',
                        description: 'Optional meeting location or video call info.'
                    },
                    startDateTime: {
                        type: 'string',
                        description: 'ISO datetime string for the meeting start time.'
                    },
                    endDateTime: {
                        type: 'string',
                        description: 'ISO datetime string for the meeting end time.'
                    },
                    timeZone: {
                        type: 'string',
                        description: 'IANA timezone name, e.g. Asia/Kolkata or America/New_York.'
                    },
                    attendees: {
                        type: 'string',
                        description: 'Comma-separated attendee email addresses.'
                    },
                    calendarId: {
                        type: 'string',
                        description: 'Google Calendar ID to insert into. Defaults to primary.'
                    }
                },
                required: ['summary', 'startDateTime', 'endDateTime']
            }
        }
    },

    execute: async (args, context) => {
        try {
            if (!args?.summary) throw new Error('Meeting summary is required.');
            if (!args?.startDateTime || !args?.endDateTime) {
                throw new Error('Both startDateTime and endDateTime are required.');
            }

            const oauth2Client = await getAuthorizedOAuthClient(context.userId);
            const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
            const calendarId = args?.calendarId || 'primary';
            const timeZone = args?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

            const event = {
                summary: String(args.summary).trim(),
                description: args?.description ? String(args.description).trim() : undefined,
                location: args?.location ? String(args.location).trim() : undefined,
                start: {
                    dateTime: toIsoDate(args.startDateTime, 'startDateTime'),
                    timeZone
                },
                end: {
                    dateTime: toIsoDate(args.endDateTime, 'endDateTime'),
                    timeZone
                },
                attendees: normalizeAttendees(args?.attendees)
            };

            Object.keys(event).forEach((key) => {
                if (event[key] === undefined || (Array.isArray(event[key]) && event[key].length === 0)) {
                    delete event[key];
                }
            });

            const response = await calendar.events.insert({
                calendarId,
                requestBody: event,
                sendUpdates: 'all'
            });

            const created = response.data || {};

            return {
                success: true,
                calendarId,
                event: {
                    id: created.id || '',
                    summary: created.summary || event.summary,
                    htmlLink: created.htmlLink || '',
                    status: created.status || 'confirmed',
                    start: created.start?.dateTime || created.start?.date || event.start.dateTime,
                    end: created.end?.dateTime || created.end?.date || event.end.dateTime
                },
                message: `Meeting "${event.summary}" scheduled successfully.`
            };
        } catch (error) {
            return {
                success: false,
                error: error.message || 'Failed to schedule Google Calendar meeting.'
            };
        }
    }
};