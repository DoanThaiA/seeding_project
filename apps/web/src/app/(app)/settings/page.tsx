import { redirect } from 'next/navigation';
import { apiGet, can, getSession } from '@/lib/api';
import { SettingsWorkspace } from './SettingsWorkspace';
import type { Capabilities, MappingT, SourceT, TargetT } from './SettingsForms';

export default async function Settings() {
  const session = await getSession();
  if (!can.admin(session.role)) redirect('/');
  const [sources, targets, mappings, capabilities] = await Promise.all([
    apiGet<SourceT[]>('/sources', session.token),
    apiGet<TargetT[]>('/targets', session.token),
    apiGet<MappingT[]>('/mappings', session.token),
    apiGet<Capabilities>('/capabilities', session.token),
  ]);
  return <SettingsWorkspace {...{ sources, targets, mappings, capabilities }} />;
}
