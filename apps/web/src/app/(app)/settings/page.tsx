import { redirect } from 'next/navigation';
import { apiGet, can, getSession } from '@/lib/api';
import { SettingsWorkspace } from './SettingsWorkspace';
import type { MappingT, SourceT, TargetT } from './SettingsForms';

export default async function Settings() {
  const session = await getSession();
  if (!can.admin(session.role)) redirect('/');
  const [sources, targets, mappings] = await Promise.all([
    apiGet<SourceT[]>('/sources', session.token),
    apiGet<TargetT[]>('/targets', session.token),
    apiGet<MappingT[]>('/mappings', session.token),
  ]);
  return <SettingsWorkspace {...{ sources, targets, mappings }} />;
}
