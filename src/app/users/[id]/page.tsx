'use client';
import { useEffect, useState, use } from 'react';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { useI18n } from '@/contexts/I18nContext';
import { useAuth } from '@/contexts/AuthContext';
import { api } from '@/lib/api';
import { formatDate, formatDateTime, getAttendanceColor } from '@/lib/utils';
import { Badge } from '@/components/ui/Badge';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

interface UserDetail {
  id: string; username: string; email: string | null; first_name: string; last_name: string;
  phone: string | null; role: string; branch_id: string | null; branch_name: string | null;
  avatar_url: string | null; is_active: boolean; last_login: string | null; created_at: string;
}

interface AttendanceRecord {
  session_date: string; status: string; group_name: string; late_minutes: number; arrival_time: string | null;
}

interface AttendanceStats {
  total: number; present: number; absent: number; late: number; avgLate: number; attendancePct: number;
}

interface Group { id: string; name: string; branch_name: string; }

export default function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t } = useI18n();
  const { user: currentUser } = useAuth();
  const router = useRouter();

  const [profile, setProfile] = useState<UserDetail | null>(null);
  const [attendance, setAttendance] = useState<{ records: AttendanceRecord[]; stats: AttendanceStats } | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get<UserDetail>(`/api/users/${id}`),
      api.get<{ records: AttendanceRecord[]; stats: AttendanceStats }>(`/api/attendance/student/${id}`),
      api.get<{ data: Group[] }>(`/api/groups`, { page: 1, limit: 100 }),
    ]).then(([u, att, grps]) => {
      setProfile(u);
      setAttendance(att);
      setGroups(grps.data.filter(g => true));
    }).catch(err => {
      console.error(err);
    }).finally(() => setLoading(false));
  }, [id]);

  const roleVariant = (role: string): 'info' | 'danger' | 'success' | 'warning' | 'purple' => {
    const map: Record<string, 'info' | 'danger' | 'success' | 'warning' | 'purple'> = {
      super_admin: 'danger', branch_admin: 'purple', teacher: 'info', student: 'success'
    };
    return map[role] || 'info';
  };

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center py-20">
          <svg className="animate-spin h-8 w-8 text-indigo-600" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
          </svg>
        </div>
      </DashboardLayout>
    );
  }

  if (!profile) {
    return (
      <DashboardLayout>
        <div className="text-center py-20 text-gray-400">{t('errors.notFound')}</div>
      </DashboardLayout>
    );
  }

  const stats = attendance?.stats;

  return (
    <DashboardLayout>
      <div className="space-y-6 max-w-4xl mx-auto">
        {/* Back button */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.back()}
          className="text-gray-500 hover:text-indigo-600 dark:text-gray-400 dark:hover:text-indigo-400 transition-colors"
        >
          <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          {t('common.back')}
        </Button>

        {/* Profile card */}
        <div className="relative bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 shadow-sm overflow-hidden">
          {/* Top accent bar */}
          <div className="h-1.5 w-full " />

          <div className="p-6">
            <div className="flex flex-col sm:flex-row items-start gap-5">
              <Avatar
                firstName={profile.first_name}
                lastName={profile.last_name}
                avatarUrl={profile.avatar_url}
                size="xl"
                className="ring-4 ring-indigo-100 dark:ring-indigo-900/30"
              />
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
                      {profile.first_name} {profile.last_name}
                    </h1>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">@{profile.username}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant={roleVariant(profile.role)} className="text-xs">
                      {t(`users.roles.${profile.role}`)}
                    </Badge>
                    <Badge variant={profile.is_active ? 'success' : 'default'} className="text-xs">
                      {profile.is_active ? t('common.active') : t('common.inactive')}
                    </Badge>
                  </div>
                </div>

                {/* Info grid */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-4">
                  {profile.email && (
                    <div className="flex items-start gap-2">
                      <svg className="w-4 h-4 text-gray-400 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                      </svg>
                      <div>
                        <p className="text-xs text-gray-400">{t('common.email')}</p>
                        <p className="text-sm text-gray-700 dark:text-gray-300 truncate">{profile.email}</p>
                      </div>
                    </div>
                  )}
                  {profile.phone && (
                    <div className="flex items-start gap-2">
                      <svg className="w-4 h-4 text-gray-400 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                      </svg>
                      <div>
                        <p className="text-xs text-gray-400">{t('common.phone')}</p>
                        <p className="text-sm text-gray-700 dark:text-gray-300">{profile.phone}</p>
                      </div>
                    </div>
                  )}
                  {profile.branch_name && (
                    <div className="flex items-start gap-2">
                      <svg className="w-4 h-4 text-gray-400 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                      </svg>
                      <div>
                        <p className="text-xs text-gray-400">{t('common.branch')}</p>
                        <p className="text-sm text-gray-700 dark:text-gray-300">{profile.branch_name}</p>
                      </div>
                    </div>
                  )}
                  <div className="flex items-start gap-2">
                    <svg className="w-4 h-4 text-gray-400 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                    <div>
                      <p className="text-xs text-gray-400">{t('profile.memberSince')}</p>
                      <p className="text-sm text-gray-700 dark:text-gray-300">{formatDate(profile.created_at)}</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-2">
                    <svg className="w-4 h-4 text-gray-400 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <div>
                      <p className="text-xs text-gray-400">{t('common.lastLogin')}</p>
                      <p className="text-sm text-gray-700 dark:text-gray-300">
                        {profile.last_login ? formatDateTime(profile.last_login) : t('common.never')}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Edit button */}
                {(currentUser?.role === 'super_admin' || currentUser?.role === 'branch_admin') && (
                  <div className="mt-5">
                    <Link href={`/users?edit=${profile.id}`}>
                      <Button variant="outline" size="sm" className="border-indigo-200 text-indigo-600 hover:bg-indigo-50 dark:border-indigo-800 dark:text-indigo-400 dark:hover:bg-indigo-900/20">
                        <svg className="w-4 h-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                        {t('users.editUser')}
                      </Button>
                    </Link>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Attendance stats */}
        {stats && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {[
              { label: t('attendance.attendanceRate'), value: `${stats.attendancePct}%`, color: 'indigo', icon: 'chart' },
              { label: t('attendance.totalPresent'), value: stats.present, color: 'green', icon: 'check' },
              { label: t('attendance.totalAbsent'), value: stats.absent, color: 'red', icon: 'x' },
              { label: t('attendance.totalLate'), value: stats.late, color: 'amber', icon: 'clock' },
              { label: t('attendance.avgLateMinutes'), value: stats.avgLate > 0 ? `${stats.avgLate}m` : '—', color: 'orange', icon: 'timer' },
            ].map((s, i) => {
              const colorMap = {
                indigo: 'bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400',
                green: 'bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400',
                red: 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400',
                amber: 'bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400',
                orange: 'bg-orange-50 dark:bg-orange-900/20 text-orange-600 dark:text-orange-400',
              };
              const iconMap = {
                chart: (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                ),
                check: (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                ),
                x: (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                ),
                clock: (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                ),
                timer: (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                ),
              };
              return (
                <div key={i} className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-4 text-center shadow-sm hover:shadow-md transition-all">
                  <div className={`inline-flex p-1.5 rounded-lg ${colorMap[s.color as keyof typeof colorMap]} mb-1`}>
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      {iconMap[s.icon as keyof typeof iconMap]}
                    </svg>
                  </div>
                  <div className={`text-xl font-bold ${colorMap[s.color as keyof typeof colorMap].split(' ')[2]}`}>
                    {s.value}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{s.label}</div>
                </div>
              );
            })}
          </div>
        )}

        {/* Attendance history */}
        <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-800 flex items-center gap-2">
            <svg className="w-4 h-4 text-indigo-600 dark:text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
            </svg>
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white">{t('attendance.history')}</h2>
          </div>
          <div className="divide-y divide-gray-100 dark:divide-gray-800 max-h-72 overflow-y-auto">
            {!attendance?.records.length ? (
              <div className="px-5 py-10 text-center text-sm text-gray-400 flex flex-col items-center gap-2">
                <svg className="w-8 h-8 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
                <span>{t('common.noData')}</span>
              </div>
            ) : (
              attendance.records.slice(0, 30).map((rec, i) => (
                <div key={i} className="px-5 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                  <div className="flex items-center gap-3">
                    <div className={`w-2 h-2 rounded-full ${rec.status === 'present' ? 'bg-green-500' : rec.status === 'absent' ? 'bg-red-500' : 'bg-amber-500'}`} />
                    <div>
                      <p className="text-sm font-medium text-gray-800 dark:text-gray-200">{rec.group_name}</p>
                      <p className="text-xs text-gray-400">{formatDate(rec.session_date)}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {rec.status === 'late' && rec.late_minutes > 0 && (
                      <span className="text-xs text-amber-600 dark:text-amber-400">
                        {t('attendance.lateBy')} {rec.late_minutes} {t('attendance.minutes')}
                      </span>
                    )}
                    <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${getAttendanceColor(rec.status)}`}>
                      {t(`attendance.${rec.status}`)}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}