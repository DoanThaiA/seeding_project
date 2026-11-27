import Link from 'next/link';
import { AutoRefresh } from '@/components/client';
import { Head } from '@/components/ui';
import { apiGet, can, getSession } from '@/lib/api';
import { ScheduleWorkspace, type BacklogItem, type Slot } from './ScheduleWorkspace';
import type { PlanSource, PublicationPlan } from './PublicationPlans';

export default async function Schedule({ searchParams }: { searchParams: Promise<{ hours?: string; view?: string; schedule?: string }> }) {
  const { hours = '24', view, schedule } = await searchParams;
  const range = ['12', '24', '72'].includes(hours) ? hours : '24';
  const scheduleId = schedule && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(schedule) ? schedule : undefined;
  const initialView = view === 'history' || scheduleId || hours !== '24' ? 'history' : view === 'backlog' ? 'backlog' : 'plans';
  const session = await getSession();
  const [slots, backlog, targets, sources, mappings, plans] = await Promise.all([
    apiGet<Slot[]>(`/slots?hours=${range}${scheduleId ? `&scheduleId=${scheduleId}` : ''}`, session.token),
    apiGet<BacklogItem[]>('/backlog', session.token),
    apiGet<Array<{ id: string; code: string; enabled: boolean }>>('/targets', session.token),
    apiGet<PlanSource[]>('/sources', session.token),
    apiGet<Array<{ sourceId: string; targetId: string; enabled: boolean }>>('/mappings', session.token),
    apiGet<PublicationPlan[]>('/publication-schedules', session.token),
  ]);
  const enabledTargets = new Set(targets.filter(t => t.enabled).map(t => t.id));
  const available = new Set(mappings.filter(m => m.enabled && enabledTargets.has(m.targetId)).map(m => m.sourceId));
  const activePlans = plans.some(plan => plan.status === 'SCHEDULED' || plan.status === 'RUNNING');
  return <>
    <AutoRefresh seconds={activePlans || scheduleId ? 5 : 20} />
    <Head title="Lịch & bài chờ" right={can.operate(session.role) && <Link href="/controls">Công tắc dừng</Link>} />
    <ScheduleWorkspace key={`${initialView}:${scheduleId ?? ''}`}
      {...{ slots, backlog, plans, range, scheduleId, initialView }}
      targets={targets.map(target => target.code)}
      sources={sources.filter(source => available.has(source.id))}
      canPublish={can.operate(session.role)}
      canReview={can.review(session.role)}
    />
  </>;
}
