import type { ProfileDetailsSnapshot } from '@seedingsys/contracts';

const sectionName: Record<ProfileDetailsSnapshot['sections'][number]['key'], string> = {
  overview: 'Tổng quan', work_and_education: 'Công việc và học vấn', places: 'Nơi từng sống', contact_and_basic_info: 'Liên hệ và thông tin cơ bản',
  family_and_relationships: 'Gia đình và các mối quan hệ', details: 'Chi tiết về hồ sơ', life_events: 'Sự kiện trong đời',
};

export function ProfileDetailsView({ snapshot }: { snapshot: ProfileDetailsSnapshot }) {
  return <div className="profile-details-view">
    <dl>
      <dt>Tên hiển thị</dt><dd><a href={snapshot.url} target="_blank" rel="noreferrer">{snapshot.name}</a></dd>
      <dt>ID Facebook</dt><dd>{snapshot.facebookId ?? 'Chưa xác minh được'}</dd>
      <dt>Tiểu sử</dt><dd>{snapshot.bio ?? 'Không đọc được'}</dd>
      {snapshot.intro.length > 0 && <><dt>Giới thiệu</dt><dd><ul>{snapshot.intro.map(line => <li key={line}>{line}</li>)}</ul></dd></>}
    </dl>
    {snapshot.sections.map(section => <details key={section.key}>
      <summary>{sectionName[section.key]}{section.status === 'UNAVAILABLE' && <span className="muted"> · Không đọc được</span>}</summary>
      {section.categories.length ? <dl>{section.categories.map(category => <div key={category.label}>
        <dt>{category.label}</dt><dd>{category.values.length ? <ul>{category.values.map(value => <li key={value}>{value}</li>)}</ul> : 'Không có mục hiển thị'}</dd>
      </div>)}</dl> : <p className="muted">Phiên quét không đọc được mục này.</p>}
    </details>)}
  </div>;
}
