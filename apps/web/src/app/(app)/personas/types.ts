import type { PersonaConfidence, PersonaGender, PersonaInsightRecord, PersonaWallSnapshot,
  SyncedProfileDetails } from '@seedingsys/contracts';

/** Bản tóm tắt gọn dùng cho danh sách và ô chọn nhân vật. */
export interface PersonaInsightBrief {
  occupation: string | null;
  gender: PersonaGender;
  ageRange: string | null;
  location: string | null;
  topics: string[];
  confidence: PersonaConfidence;
}

export interface PersonaSummary {
  id: string;
  code: string;
  name: string;
  enabled: boolean;
  connector: string;
  canComment: boolean;
  sourceCode: string | null;
  description: string | null;
  publishedCount: number;
  insight: PersonaInsightBrief | null;
}

export interface PersonaDetail {
  id: string;
  code: string;
  name: string;
  enabled: boolean;
  connector: string;
  canComment: boolean;
  profileUrl: string | null;
  sourceProfile: SyncedProfileDetails | null;
  context: { name: string | null; bio: string | null; sourceCode: string | null } | null;
  wall: { capturedAt: string; warning: string | null; posts: PersonaWallSnapshot['posts'] } | null;
  mappings: { id: string; source: { code: string; name: string; connector: string } }[];
  publications: { id: string; sourcePostId: string; caption: string; contentType: string;
    sourceCode: string; recordedAt: string; permalink: string | null }[];
  postPage: number;
  more: boolean;
  insight: PersonaInsightRecord | null;
  insightRun: { status: string; message: string | null; createdAt: string } | null;
}

/** Một dòng trong bảng trạng thái tóm tắt của mọi nhân vật. */
export interface PersonaSummaryRow {
  id: string;
  code: string;
  name: string;
  enabled: boolean;
  hasProfile: boolean;
  status: string | null;
  message: string | null;
  runAt: string | null;
  insight: PersonaInsightRecord | null;
}
