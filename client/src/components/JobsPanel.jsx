import React, { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import styled from 'styled-components';
import { SocketContext } from '../contexts/SocketContext';
import { useExecution } from '../contexts/ExecutionContext';
import { useWorkspace } from '../contexts/WorkspaceContext';
import {
  cancelJob,
  createJob,
  listJobs,
  listRuns,
  markNotificationsRead,
  pauseJob,
  resumeJob,
  runJobNow
} from '../lib/jobsApi';

// JARVIS Phase 4 — scheduled jobs (proactive autonomy).
//
// A job is a durable definition separate from chat and from a single plan
// run. This panel is presentation + explicit user intent only: the server
// owns scheduling, the permission scope, and execution. Anything above
// read/reversible is deliberately not schedulable in this slice, so the UI
// never implies an unattended external side effect.

const Wrap = styled.section`
  background: var(--surface);
  border: 1px solid rgba(var(--primary-rgb), 0.14);
  border-radius: 12px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.3);
  overflow: hidden;
  min-width: 0;
  max-width: 100%;
`;

const Header = styled.button`
  appearance: none;
  width: 100%;
  border: 0;
  background: transparent;
  color: var(--foreground);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  text-align: left;

  &:hover { background: rgba(255, 255, 255, 0.04); }
`;

const HeaderText = styled.span`
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const Count = styled.span`
  font-size: 10px;
  font-weight: 700;
  color: var(--background);
  background: var(--primary-hex);
  border-radius: 999px;
  padding: 1px 6px;
`;

const Toggle = styled.span`
  color: rgba(215, 250, 255, 0.55);
  font-size: 12px;
`;

const Body = styled.div`
  padding: 0 10px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 360px;
  overflow-y: auto;
`;

const Notice = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 7px 8px;
  border-radius: 8px;
  border: 1px solid rgba(var(--primary-rgb), 0.22);
  background: rgba(var(--primary-rgb), 0.08);
  font-size: 10px;
  color: rgba(215, 250, 255, 0.8);
`;

const NoticeText = styled.span`
  flex: 1;
  min-width: 0;
`;

const SmallButton = styled.button`
  appearance: none;
  border: 1px solid rgba(var(--primary-rgb), 0.35);
  background: rgba(var(--primary-rgb), 0.12);
  color: var(--foreground);
  font-size: 10px;
  font-weight: 600;
  border-radius: 7px;
  padding: 4px 8px;
  cursor: pointer;
  white-space: nowrap;

  &:hover:not(:disabled) { background: rgba(var(--primary-rgb), 0.22); }
  &:disabled { opacity: 0.55; cursor: default; }
`;

const ActionRow = styled.div`
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: flex-end;
`;

const JobRow = styled.div`
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 8px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.07);
  min-width: 0;
`;

const JobTop = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
`;

const JobMain = styled.div`
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
`;

const Title = styled.span`
  font-size: 11px;
  font-weight: 600;
  color: var(--foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const Meta = styled.span`
  font-size: 10px;
  color: rgba(215, 250, 255, 0.55);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const Badge = styled.span`
  flex-shrink: 0;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  border-radius: 999px;
  padding: 2px 6px;
  color: ${({ $tone }) => $tone};
  border: 1px solid ${({ $tone }) => $tone};
  background: transparent;
`;

const Form = styled.form`
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 9px;
  border-radius: 8px;
  border: 1px dashed rgba(var(--primary-rgb), 0.25);
  background: rgba(255, 255, 255, 0.02);
`;

const FieldRow = styled.div`
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
`;

const Label = styled.label`
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: rgba(215, 250, 255, 0.55);
  flex: 1;
  min-width: 110px;
`;

const Control = styled.input`
  appearance: none;
  width: 100%;
  min-width: 0;
  background: rgba(0, 0, 0, 0.25);
  color: var(--foreground);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 7px;
  padding: 6px 7px;
  font-size: 11px;
  font-family: inherit;

  &:focus { outline: 1px solid rgba(var(--primary-rgb), 0.6); outline-offset: -1px; }
`;

const Select = styled.select`
  appearance: none;
  width: 100%;
  min-width: 0;
  background: rgba(0, 0, 0, 0.25);
  color: var(--foreground);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 7px;
  padding: 6px 7px;
  font-size: 11px;
  font-family: inherit;

  option { background: #0d0e20; color: #e8fbff; }
`;

const Hint = styled.div`
  font-size: 10px;
  color: rgba(215, 250, 255, 0.55);
  line-height: 1.4;
`;

const ErrorText = styled.div`
  font-size: 10px;
  color: #ff8f8f;
  white-space: pre-wrap;
`;

const CheckRow = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  color: rgba(215, 250, 255, 0.7);
`;

const Runs = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 7px;
  border-radius: 7px;
  background: rgba(0, 0, 0, 0.22);
  border: 1px solid rgba(255, 255, 255, 0.06);
`;

const RunRow = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-bottom: 4px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);

  &:last-child { border-bottom: 0; padding-bottom: 0; }
`;

const RunMeta = styled.span`
  font-size: 9px;
  color: rgba(215, 250, 255, 0.5);
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
`;

const RUN_STATUS_TONE = {
  SUCCEEDED: 'var(--success)',
  FAILED: 'var(--destructive)',
  BLOCKED: 'var(--warning)',
  CANCELLED: 'var(--foreground-subtle)',
  RUNNING: 'var(--primary-hex)'
};

const JOB_STATUS_TONE = {
  ACTIVE: 'var(--success)',
  PAUSED: 'var(--warning)',
  FAILED: 'var(--destructive)',
  COMPLETED: 'var(--success)',
  CANCELLED: 'var(--foreground-subtle)'
};

const PRESETS = [
  { key: 'daily', label: 'Daily · 09:00', cron: '0 9 * * *' },
  { key: 'weekdays', label: 'Weekdays · 08:00', cron: '0 8 * * 1-5' },
  { key: 'hourly', label: 'Hourly', cron: '0 * * * *' },
  { key: 'weekly', label: 'Weekly · Mon 09:00', cron: '0 9 * * 1' },
  { key: 'custom', label: 'Custom cron', cron: '' }
];

const pad = (n) => String(n).padStart(2, '0');

const defaultOnceValue = () => {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const formatWhen = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
};

const formatDuration = (start, end) => {
  if (!start || !end) return '';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60000)}m`;
};

const defaultTimezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

const JobsPanel = () => {
  const { socket } = useContext(SocketContext) || {};
  const { activeWorkspaceId } = useWorkspace();
  const { plans = [] } = useExecution();

  const [expanded, setExpanded] = useState(false);
  const [jobs, setJobs] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [confirmCancelId, setConfirmCancelId] = useState(null);
  const [runsByJob, setRunsByJob] = useState({});
  const [showForm, setShowForm] = useState(false);

  const [selectedPlanId, setSelectedPlanId] = useState('');
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState('schedule');
  const [preset, setPreset] = useState('daily');
  const [cron, setCron] = useState(PRESETS[0].cron);
  const [runAt, setRunAt] = useState(defaultOnceValue);
  const [timezone, setTimezone] = useState(defaultTimezone);
  const [notifySuccess, setNotifySuccess] = useState(true);
  const [notifyFailure, setNotifyFailure] = useState(true);
  const [creating, setCreating] = useState(false);

  const planOptions = useMemo(
    () => plans.filter((plan) => plan && plan.executionId && (plan.stepCount === undefined || plan.stepCount > 0)),
    [plans]
  );

  const selectedPlan = useMemo(
    () => planOptions.find((plan) => plan.executionId === selectedPlanId) || null,
    [planOptions, selectedPlanId]
  );

  const load = useCallback(async () => {
    try {
      const data = await listJobs(activeWorkspaceId || undefined);
      setJobs(Array.isArray(data.jobs) ? data.jobs : []);
      setUnreadCount(Number(data.unreadCount) || 0);
    } catch (err) {
      setError(err?.message || 'Could not load scheduled jobs.');
    }
  }, [activeWorkspaceId]);

  useEffect(() => {
    setRunsByJob({});
    void load();
  }, [load]);

  useEffect(() => {
    if (!socket) return undefined;
    const onUpdated = (payload) => {
      const job = payload?.job;
      if (!job || String(job.workspaceId || 'global') !== String(activeWorkspaceId || 'global')) return;
      setJobs((prev) => {
        const index = prev.findIndex((item) => item.jobId === job.jobId);
        if (index === -1) return [job, ...prev];
        const next = [...prev];
        next[index] = { ...next[index], ...job };
        return next;
      });
    };
    const onNotification = (payload) => {
      if (!payload) return;
      if (String(payload.workspaceId || 'global') !== String(activeWorkspaceId || 'global')) return;
      setUnreadCount((count) => count + (payload.unread === false ? 0 : 1));
      setNotice({
        title: payload.title || 'Scheduled job',
        status: payload.status || 'SUCCEEDED',
        summary: payload.summary || '',
        error: payload.error || ''
      });
      void load();
    };
    socket.on('job.updated', onUpdated);
    socket.on('job.notification', onNotification);
    return () => {
      socket.off('job.updated', onUpdated);
      socket.off('job.notification', onNotification);
    };
  }, [socket, activeWorkspaceId, load]);

  useEffect(() => {
    const onScheduleRequest = (event) => {
      const executionId = event?.detail?.executionId;
      if (!executionId) return;
      setSelectedPlanId(executionId);
      const plan = planOptions.find((item) => item.executionId === executionId);
      if (plan?.title) setTitle(plan.title);
      setShowForm(true);
      setExpanded(true);
    };
    window.addEventListener('arc:schedule-plan', onScheduleRequest);
    return () => window.removeEventListener('arc:schedule-plan', onScheduleRequest);
  }, [planOptions]);

  const handleMarkRead = async () => {
    try {
      await markNotificationsRead(activeWorkspaceId || undefined);
      setUnreadCount(0);
    } catch {
      // Non-critical; the badge simply stays until the next load.
    }
  };

  const handleJobAction = async (job, action) => {
    setBusyId(job.jobId);
    setError(null);
    setNotice(null);
    try {
      if (action === 'pause') await pauseJob(job.jobId, activeWorkspaceId || undefined);
      else if (action === 'resume') await resumeJob(job.jobId, activeWorkspaceId || undefined);
      else if (action === 'cancel') await cancelJob(job.jobId, activeWorkspaceId || undefined);
      else if (action === 'run') {
        const result = await runJobNow(job.jobId, activeWorkspaceId || undefined);
        if (result?.blocked) {
          setError(result?.run?.error || 'This job was blocked by its permission scope.');
        }
      }
      await load();
    } catch (err) {
      setError(err?.message || 'Could not update this job.');
    } finally {
      setBusyId(null);
      setConfirmCancelId(null);
    }
  };

  const toggleRuns = async (job) => {
    if (runsByJob[job.jobId]) {
      setRunsByJob((prev) => {
        const next = { ...prev };
        delete next[job.jobId];
        return next;
      });
      return;
    }
    setBusyId(job.jobId);
    setError(null);
    try {
      const data = await listRuns(job.jobId, activeWorkspaceId || undefined);
      setRunsByJob((prev) => ({ ...prev, [job.jobId]: Array.isArray(data.runs) ? data.runs : [] }));
    } catch (err) {
      setError(err?.message || 'Could not load run history.');
    } finally {
      setBusyId(null);
    }
  };

  const startForm = () => {
    setShowForm((value) => !value);
    setError(null);
    if (!selectedPlanId && planOptions[0]) {
      setSelectedPlanId(planOptions[0].executionId);
      setTitle(planOptions[0].title || 'Scheduled job');
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    setError(null);
    if (!selectedPlan) {
      setError('Choose a recent plan to schedule.');
      return;
    }
    if (mode === 'schedule' && !cron.trim()) {
      setError('Enter a cron expression or choose a preset.');
      return;
    }
    if (mode === 'once' && !runAt) {
      setError('Choose when the one-time job should run.');
      return;
    }

    setCreating(true);
    try {
      const trigger = mode === 'once'
        ? { type: 'once', runAt: new Date(runAt).toISOString(), timezone }
        : { type: 'schedule', cron: cron.trim(), timezone };
      await createJob({
        workspaceId: activeWorkspaceId || undefined,
        sourceExecutionId: selectedPlan.executionId,
        title: title.trim() || selectedPlan.title || 'Scheduled job',
        trigger,
        notifyOn: { success: notifySuccess, failure: notifyFailure }
      });
      setShowForm(false);
      setNotice({ title: 'Scheduled job created', status: 'SUCCEEDED', summary: 'It will run inside its read/reversible permission scope.', error: '' });
      await load();
    } catch (err) {
      setError(err?.message || 'Could not create the scheduled job.');
    } finally {
      setCreating(false);
    }
  };

  const activeCount = jobs.filter((job) => job.status === 'ACTIVE').length;
  const headerText = jobs.length
    ? `Scheduled jobs · ${activeCount} active`
    : 'Scheduled jobs';

  return (
    <Wrap aria-label="Scheduled jobs">
      <Header type="button" onClick={() => setExpanded((value) => !value)}>
        <span aria-hidden="true">◷</span>
        <HeaderText>{headerText}</HeaderText>
        {unreadCount > 0 && <Count>{unreadCount}</Count>}
        <Toggle>{expanded ? '▾' : '▸'}</Toggle>
      </Header>

      {expanded && (
        <Body>
          <Notice>
            <NoticeText>
              Scheduled jobs run unattended only for read/reversible capabilities. Consequential actions stay interactive.
            </NoticeText>
            {unreadCount > 0 && (
              <SmallButton type="button" onClick={handleMarkRead}>Mark read</SmallButton>
            )}
          </Notice>

          {notice && (
            <Notice>
              <NoticeText>
                <strong>{notice.title}</strong>
                {notice.summary ? ` — ${notice.summary}` : ''}
                {notice.error ? ` — ${notice.error}` : ''}
              </NoticeText>
              <SmallButton type="button" onClick={() => setNotice(null)}>Dismiss</SmallButton>
            </Notice>
          )}

          {!jobs.length && (
            <Hint>
              No scheduled jobs yet. Run a multi-step task, then schedule that plan here.
            </Hint>
          )}

          {jobs.map((job) => {
            const tone = JOB_STATUS_TONE[job.status] || 'var(--foreground-subtle)';
            const runs = runsByJob[job.jobId];
            const isBusy = busyId === job.jobId;
            return (
              <JobRow key={job.jobId}>
                <JobTop>
                  <JobMain>
                    <Title title={job.title}>{job.title}</Title>
                    <Meta title={job.trigger?.description}>
                      {job.trigger?.description} · next {formatWhen(job.nextRunAt)}
                      {job.lastRunStatus ? ` · last ${String(job.lastRunStatus).toLowerCase()}` : ''}
                    </Meta>
                    {job.lastError ? <Meta title={job.lastError}>⚠ {job.lastError}</Meta> : null}
                  </JobMain>
                  <Badge $tone={tone}>{job.status}</Badge>
                </JobTop>

                <ActionRow>
                  {job.status === 'ACTIVE' && (
                    <SmallButton type="button" disabled={isBusy} onClick={() => handleJobAction(job, 'pause')}>
                      Pause
                    </SmallButton>
                  )}
                  {(job.status === 'PAUSED' || (job.status === 'FAILED' && job.trigger?.type !== 'once')) && (
                    <SmallButton type="button" disabled={isBusy} onClick={() => handleJobAction(job, 'resume')}>
                      Resume
                    </SmallButton>
                  )}
                  {!['CANCELLED', 'COMPLETED'].includes(job.status) && (
                    <SmallButton type="button" disabled={isBusy || job.lastRunStatus === 'RUNNING'} onClick={() => handleJobAction(job, 'run')}>
                      Run now
                    </SmallButton>
                  )}
                  <SmallButton type="button" disabled={isBusy} onClick={() => toggleRuns(job)}>
                    {runs ? 'Hide history' : 'History'}
                  </SmallButton>
                  {!['CANCELLED', 'COMPLETED'].includes(job.status) && (
                    confirmCancelId === job.jobId ? (
                      <SmallButton type="button" disabled={isBusy} onClick={() => handleJobAction(job, 'cancel')}>
                        Confirm cancel
                      </SmallButton>
                    ) : (
                      <SmallButton type="button" disabled={isBusy} onClick={() => setConfirmCancelId(job.jobId)}>
                        Cancel
                      </SmallButton>
                    )
                  )}
                </ActionRow>

                {runs && (
                  <Runs>
                    {!runs.length && <Hint>No runs yet.</Hint>}
                    {runs.slice(0, 6).map((run) => (
                      <RunRow key={run.runId}>
                        <RunMeta>
                          <span style={{ color: RUN_STATUS_TONE[run.status] || 'inherit', fontWeight: 700 }}>
                            {run.status}
                          </span>
                          <span>{formatWhen(run.startedAt)}</span>
                          <span>{formatDuration(run.startedAt, run.finishedAt)}</span>
                          <span>{run.trigger}</span>
                        </RunMeta>
                        {run.summary ? <Meta title={run.summary}>{run.summary}</Meta> : null}
                        {run.error ? <Meta title={run.error}>⚠ {run.error}</Meta> : null}
                        {(run.evidence || []).map((item, index) => (
                          <Meta key={`${run.runId}-${index}`} title={`${item.label}: ${item.value}`}>
                            {item.label}: {item.value}
                          </Meta>
                        ))}
                      </RunRow>
                    ))}
                  </Runs>
                )}
              </JobRow>
            );
          })}

          {planOptions.length > 0 && (
            <SmallButton type="button" onClick={startForm}>
              {showForm ? 'Close' : 'New schedule'}
            </SmallButton>
          )}

          {showForm && planOptions.length > 0 && (
            <Form onSubmit={submit}>
              <FieldRow>
                <Label>
                  Plan
                  <Select
                    value={selectedPlanId}
                    onChange={(event) => {
                      const nextId = event.target.value;
                      setSelectedPlanId(nextId);
                      const plan = planOptions.find((item) => item.executionId === nextId);
                      if (plan?.title) setTitle(plan.title);
                    }}
                  >
                    {planOptions.map((plan) => (
                      <option key={plan.executionId} value={plan.executionId}>
                        {plan.title || 'Autonomous plan'}
                      </option>
                    ))}
                  </Select>
                </Label>
                <Label>
                  Title
                  <Control
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder="Scheduled job title"
                    maxLength={140}
                  />
                </Label>
              </FieldRow>

              <FieldRow>
                <Label>
                  Runs
                  <Select value={mode} onChange={(event) => setMode(event.target.value)}>
                    <option value="schedule">Recurring schedule</option>
                    <option value="once">Once</option>
                  </Select>
                </Label>
                {mode === 'schedule' ? (
                  <Label>
                    Preset
                    <Select
                      value={preset}
                      onChange={(event) => {
                        const key = event.target.value;
                        setPreset(key);
                        const found = PRESETS.find((item) => item.key === key);
                        if (found) setCron(found.cron);
                      }}
                    >
                      {PRESETS.map((item) => (
                        <option key={item.key} value={item.key}>{item.label}</option>
                      ))}
                    </Select>
                  </Label>
                ) : (
                  <Label>
                    Run at
                    <Control
                      type="datetime-local"
                      value={runAt}
                      onChange={(event) => setRunAt(event.target.value)}
                    />
                  </Label>
                )}
                <Label>
                  Timezone
                  <Control
                    value={timezone}
                    onChange={(event) => setTimezone(event.target.value)}
                    placeholder="UTC"
                  />
                </Label>
              </FieldRow>

              {mode === 'schedule' && (
                <FieldRow>
                  <Label>
                    Cron
                    <Control
                      value={cron}
                      onChange={(event) => {
                        setCron(event.target.value);
                        setPreset('custom');
                      }}
                      placeholder="0 9 * * *"
                    />
                  </Label>
                </FieldRow>
              )}

              <CheckRow>
                <input
                  type="checkbox"
                  checked={notifySuccess}
                  onChange={(event) => setNotifySuccess(event.target.checked)}
                />
                Notify on success
                <input
                  type="checkbox"
                  checked={notifyFailure}
                  onChange={(event) => setNotifyFailure(event.target.checked)}
                />
                Notify on failure
              </CheckRow>

              <Hint>
                Only read/reversible steps can run unattended. If this plan contains a consequential tool, scheduling is rejected.
              </Hint>

              <ActionRow>
                <SmallButton type="submit" disabled={creating}>
                  {creating ? 'Scheduling…' : 'Schedule job'}
                </SmallButton>
              </ActionRow>
            </Form>
          )}

          {error && <ErrorText>{error}</ErrorText>}
        </Body>
      )}
    </Wrap>
  );
};

export default JobsPanel;
