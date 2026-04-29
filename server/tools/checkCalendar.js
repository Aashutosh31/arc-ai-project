const { google } = require('googleapis');
const { getAuthorizedOAuthClient } = require('../services/googleCalendarService');

const buildTimeWindow = (args) => {
    const now = new Date();
    const timeMin = args.timeMin ? new Date(args.timeMin) : now;
    const timeMax = args.timeMax ? new Date(args.timeMax) : new Date(now.getTime() + 1000 * 60 * 60 * 24 * 7);

    if (Number.isNaN(timeMin.getTime()) || Number.isNaN(timeMax.getTime())) {
        throw new Error('Invalid timeMin or timeMax supplied to checkCalendar.');
    }

    return { timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString() };
};

const formatEventTime = (eventTime) => {
    if (!eventTime) return 'Unknown time';
    return eventTime.dateTime || eventTime.date || 'Unknown time';
};

module.exports = {
    schema: {
        type: 'function',
        function: {
            name: 'checkCalendar',
            description: 'Read the user\'s Google Calendar and return upcoming events within a time window. Use this before scheduling to check availability.',
            parameters: {
                type: 'object',
                properties: {
                    timeMin: {
                        type: 'string',
                        description: 'ISO datetime start of the search window. Defaults to now.'
                    },
                    timeMax: {
                        type: 'string',
                        description: 'ISO datetime end of the search window. Defaults to 7 days from now.'
                    },
                    maxResults: {
                        type: 'integer',
                        description: 'Maximum number of events to return. Default 10.'
                    },
                    calendarId: {
                        type: 'string',
                        description: 'Google Calendar ID to inspect. Defaults to primary.'
                    }
                }
            }
        }
    },

    execute: async (args, context) => {
        try {
            const oauth2Client = await getAuthorizedOAuthClient(context.userId);
            const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
            const { timeMin, timeMax } = buildTimeWindow(args || {});
            const calendarId = args?.calendarId || 'primary';
            const maxResults = Math.min(Math.max(Number(args?.maxResults || 10), 1), 50);

            const response = await calendar.events.list({
                calendarId,
                timeMin,
                timeMax,
                maxResults,
                singleEvents: true,
                orderBy: 'startTime'
            });

            const events = (response.data.items || []).map((event) => ({
                id: event.id,
                summary: event.summary || 'Untitled event',
                description: event.description || '',
                location: event.location || '',
                start: formatEventTime(event.start),
                end: formatEventTime(event.end),
                attendees: Array.isArray(event.attendees)
                    ? event.attendees.map((attendee) => attendee.email).filter(Boolean)
                    : [],
                status: event.status || 'confirmed',
                htmlLink: event.htmlLink || ''
            }));

            return {
                success: true,
                calendarId,
                timeMin,
                timeMax,
                count: events.length,
                events,
                message: events.length
                    ? `Found ${events.length} calendar event(s).`
                    : 'No events found in the requested window.'
            };
        } catch (error) {
            return {
                success: false,
                error: error.message || 'Failed to read Google Calendar.'
            };
        }
    }
};