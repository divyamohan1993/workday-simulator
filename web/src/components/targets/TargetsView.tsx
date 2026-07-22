import { useState } from 'react';
import type { DeliveryTarget } from '@/types/api';
import type { DeliveryTargetInput, TestConnectionResult } from '@/lib/api-types';
import { api } from '@/lib/services';
import { ApiError } from '@/lib/api-client';
import { useAsync } from '@/hooks/use-async';
import { useUiStore } from '@/store/ui-store';
import { DELIVERY_KIND_LABEL } from '@/lib/constants';
import { formatMs, humanizeKind } from '@/lib/format';
import { Badge, Button, EmptyState, ErrorState, LoadingRows, Panel } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { TargetForm } from '@/components/targets/TargetForm';

interface TestState {
  loading?: boolean;
  result?: TestConnectionResult;
}

/**
 * Manage delivery targets: the built-in reference receiver plus any external
 * Identity Managers. Full CRUD, with a per-row connection test (which needs a
 * persisted id, so it lives on saved rows, never on the unsaved form).
 */
export default function TargetsView(): React.JSX.Element {
  const pushToast = useUiStore((s) => s.pushToast);
  const { data, error, initialLoading, refetch } = useAsync(
    (signal) => api.listTargets({ limit: 200 }, signal),
    [],
  );

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<DeliveryTarget | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [toDelete, setToDelete] = useState<DeliveryTarget | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [tests, setTests] = useState<Record<string, TestState>>({});

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }
  function openEdit(t: DeliveryTarget) {
    setEditing(t);
    setDialogOpen(true);
  }

  async function handleSubmit(input: DeliveryTargetInput) {
    setSubmitting(true);
    try {
      if (editing) {
        await api.updateTarget(editing.id, input);
        pushToast({ tone: 'good', title: 'Target updated', message: input.name });
      } else {
        await api.createTarget(input);
        pushToast({ tone: 'good', title: 'Target created', message: input.name });
      }
      setDialogOpen(false);
      refetch();
    } catch (err) {
      pushToast({
        tone: 'critical',
        title: 'Could not save target',
        message: err instanceof ApiError ? err.message : 'Unexpected error',
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await api.deleteTarget(toDelete.id);
      pushToast({ tone: 'good', title: 'Target deleted', message: toDelete.name });
      setToDelete(null);
      refetch();
    } catch (err) {
      const msg =
        err instanceof ApiError && err.status === 409
          ? 'The built-in receiver is protected and cannot be deleted.'
          : err instanceof ApiError
            ? err.message
            : 'Unexpected error';
      pushToast({ tone: 'critical', title: 'Could not delete', message: msg });
    } finally {
      setDeleting(false);
    }
  }

  async function handleTest(t: DeliveryTarget) {
    setTests((s) => ({ ...s, [t.id]: { loading: true } }));
    try {
      const result = await api.testTarget(t.id);
      setTests((s) => ({ ...s, [t.id]: { result } }));
      pushToast({
        tone: result.ok ? 'good' : 'critical',
        title: result.ok ? 'Connection OK' : 'Connection failed',
        message: result.ok
          ? `${t.name} responded in ${formatMs(result.latencyMs ?? 0)}`
          : result.error ?? `HTTP ${result.httpStatus ?? '?'}`,
      });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Unexpected error';
      setTests((s) => ({ ...s, [t.id]: { result: { ok: false, error: message } } }));
      pushToast({ tone: 'critical', title: 'Test failed', message });
    }
  }

  const targets = data?.items ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Delivery targets</h1>
          <p className="text-sm text-[var(--ink-3)]">
            Where the event stream is delivered: the built-in reference OneIM, or an external Identity Manager over SCIM, webhook, REST, NATS, or batch.
          </p>
        </div>
        <Button variant="primary" iconLeft="plus" onClick={openCreate}>
          New target
        </Button>
      </div>

      {initialLoading ? (
        <Panel><LoadingRows rows={3} /></Panel>
      ) : error ? (
        <Panel><ErrorState error={error} onRetry={refetch} /></Panel>
      ) : targets.length === 0 ? (
        <Panel>
          <EmptyState icon="target" title="No targets yet" message="Add a delivery target to point the simulator at an Identity Manager." action={<Button variant="primary" iconLeft="plus" onClick={openCreate}>New target</Button>} />
        </Panel>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {targets.map((t) => {
            const test = tests[t.id];
            return (
              <Panel key={t.id} className="flex flex-col">
                <div className="flex items-start justify-between gap-2 p-4 pb-0">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 font-semibold">
                      <span className="clip-text">{t.name}</span>
                      {t.builtIn && <Badge tone="good" icon="server">Built-in</Badge>}
                    </p>
                    <p className="mono mt-1 clip-text text-xs text-[var(--ink-3)]" title={t.url}>{t.url}</p>
                  </div>
                  <Badge>{DELIVERY_KIND_LABEL[t.kind]}</Badge>
                </div>

                <div className="grid grid-cols-3 gap-2 px-4 py-3 text-xs">
                  <span className="text-[var(--ink-3)]">Auth<br /><span className="text-[var(--ink-2)]">{humanizeKind(t.auth.kind)}</span></span>
                  <span className="text-[var(--ink-3)]">Concurrency<br /><span className="tnum text-[var(--ink-2)]">{t.concurrency}</span></span>
                  <span className="text-[var(--ink-3)]">Overflow<br /><span className="text-[var(--ink-2)]">{humanizeKind(t.overflowPolicy)}</span></span>
                </div>

                {test?.result && (
                  <div className="px-4 pb-2">
                    <Badge tone={test.result.ok ? 'good' : 'critical'} icon={test.result.ok ? 'check' : 'x'}>
                      {test.result.ok
                        ? `OK · ${formatMs(test.result.latencyMs ?? 0)}`
                        : `Failed${test.result.httpStatus ? ` · ${test.result.httpStatus}` : ''}`}
                    </Badge>
                  </div>
                )}

                <div className="mt-auto flex items-center gap-1 border-t border-[var(--border-faint)] p-2">
                  <Button size="sm" variant="ghost" iconLeft="plug" loading={test?.loading} onClick={() => handleTest(t)}>
                    Test
                  </Button>
                  <Button size="sm" variant="ghost" iconLeft="edit" onClick={() => openEdit(t)}>
                    Edit
                  </Button>
                  <button
                    className="btn btn-sm btn-ghost ml-auto"
                    onClick={() => setToDelete(t)}
                    disabled={t.builtIn}
                    title={t.builtIn ? 'The built-in receiver is protected' : 'Delete target'}
                    aria-label={`Delete ${t.name}`}
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </div>
              </Panel>
            );
          })}
        </div>
      )}

      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title={editing ? 'Edit target' : 'New delivery target'}
        description={editing ? editing.name : 'Point the event stream at an Identity Manager'}
        size="xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button variant="primary" type="submit" form="target-form" loading={submitting} iconLeft="check">
              {editing ? 'Save changes' : 'Create target'}
            </Button>
          </>
        }
      >
        <TargetForm formId="target-form" initial={editing} onSubmit={handleSubmit} />
      </Dialog>

      <Dialog
        open={toDelete !== null}
        onClose={() => setToDelete(null)}
        title="Delete target?"
        description={toDelete?.name}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setToDelete(null)}>Cancel</Button>
            <Button variant="danger" loading={deleting} iconLeft="trash" onClick={handleDelete}>Delete</Button>
          </>
        }
      >
        <p className="text-sm text-[var(--ink-2)]">
          This soft-deletes the target. Historical runs that referenced it stay resolvable, but it will no longer appear in the target list.
        </p>
      </Dialog>
    </div>
  );
}
