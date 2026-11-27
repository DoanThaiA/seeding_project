import { apiGet, can, getSession } from '@/lib/api';
import { ProfileGroups, type ProfileDirectory } from './ProfileGroups';

export default async function ProfileGroupsPage() {
  const session = await getSession();
  const data = await apiGet<ProfileDirectory>('/profile-groups', session.token);
  return <>
    <h1>Nhóm hồ sơ</h1>
    <ProfileGroups directory={data} canEdit={can.operate(session.role)} />
  </>;
}
