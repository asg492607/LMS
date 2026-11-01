import React, { useEffect, useMemo, useState } from 'react';
import { supabase } from './supabase.js';
import { getAccessToken } from './apiAuth.js';
import { apiUrl } from './apiBase.js';
import './portal.css';

const roleInfo = {
  school_admin: { title: 'School administrator', headline: 'A clear view of your school', copy: 'Track the academic structure and people across your school.' },
  dean: { title: 'Dean', headline: 'Lead your school with context', copy: 'Review programs, teaching groups, and the people connected to your school.' },
  hod: { title: 'Head of department', headline: 'Your department, in one view', copy: 'See programs, courses, divisions, and teaching coverage for your department.' },
  subject_coordinator: { title: 'Course coordinator', headline: 'Coordinate learning across divisions', copy: 'Plan assessments and keep teaching groups aligned.' },
  subject_teacher: { title: 'Subject teacher', headline: 'Your teaching workspace', copy: 'Share resources, publish assessments, and follow learner submissions.' },
  class_teacher: { title: 'Class teacher', headline: 'Your class at a glance', copy: 'Keep track of your division, its learners, and academic updates.' },
  student: { title: 'Student', headline: 'Your learning, organized', copy: 'Find your courses, assessments, resources, and feedback in one place.' },
};

const EMPTY_LIST = Object.freeze([]);

const roleTabs = [
  { id: 'overview', label: 'Overview', icon: '⌂' },
  { id: 'courses', label: 'My courses', icon: '▤' },
  { id: 'assessments', label: 'Quizzes & assignments', icon: '✓' },
  { id: 'resources', label: 'Resources', icon: '▧' },
  { id: 'announcements', label: 'Announcements', icon: '◉' },
];

function greeting() {
  const hour = new Date().getHours();
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}

function sortByName(items = []) {
  return [...items].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

function formatDate(value, includeTime = false) {
  if (!value) return 'No deadline';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Date unavailable';
  return new Intl.DateTimeFormat('en-IN', includeTime
    ? { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }
    : { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }).format(date);
}

function todayInputValue() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function summarizeAttendance(sessions = []) {
  const records = sessions.flatMap((session) => session.records || []);
  const excused = records.filter((record) => record.status === 'excused').length;
  const eligible = records.length - excused;
  const attended = records.filter((record) => ['present', 'late'].includes(record.status)).length;
  return {
    sessions: sessions.length,
    present: records.filter((record) => record.status === 'present').length,
    late: records.filter((record) => record.status === 'late').length,
    absent: records.filter((record) => record.status === 'absent').length,
    excused,
    eligible,
    percentage: eligible ? Math.round((attended / eligible) * 100) : null,
  };
}

function EmptyState({ title, children }) {
  return <div className="portal-empty"><span className="portal-empty-mark">✳</span><strong>{title}</strong><p>{children}</p></div>;
}

function StatCard({ label, value, detail, icon }) {
  return <article className="portal-stat"><span className="portal-stat-icon" aria-hidden="true">{icon}</span><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div></article>;
}

function percentage(value) {
  return value == null ? '—' : `${value}%`;
}

function AnalysisPanel({ analysis, semesters, selectedSemesterId, onSemesterChange, role }) {
  const summary = selectedSemesterId === 'all'
    ? analysis?.summary
    : semesters.find((semester) => semester.id === selectedSemesterId) || analysis?.summary;
  const subjects = (analysis?.subjects || []).filter((subject) =>
    selectedSemesterId === 'all' || subject.semesterId === selectedSemesterId);
  const divisions = (analysis?.divisions || []).filter((division) =>
    selectedSemesterId === 'all' || division.semesterId === selectedSemesterId);
  const hasRecords = Boolean(summary?.publishedAssessments || summary?.submissions || summary?.attendanceRate != null);
  const scoreBands = summary?.scoreBands || {};
  const scoreCount = Object.values(scoreBands).reduce((total, value) => total + (Number(value) || 0), 0);

  return <section className="portal-tab-panel portal-analysis-panel">
    <div className="portal-tab-heading">
      <div><p className="portal-eyebrow">Academic quality · {summary?.students || 0} learners</p><h2>{role === 'hod' ? 'Department academic analysis' : 'School academic analysis'}</h2><p>Compare attendance, assessment completion, and course performance by semester, subject, and division.</p></div>
      <label className="portal-analysis-filter">Academic semester<select value={selectedSemesterId} onChange={(event) => onSemesterChange(event.target.value)}><option value="all">All semesters</option>{semesters.map((semester) => <option value={semester.id} key={semester.id}>{semester.name}</option>)}</select></label>
    </div>

    {!subjects.length ? <EmptyState title="No semester subjects in this scope">Register a program, semester, and subject offering to see academic analysis.</EmptyState> : <>
      <div className="portal-analysis-metrics">
        <article><span>Attendance rate</span><strong>{percentage(summary?.attendanceRate)}</strong><small>Present and late records; excused sessions excluded</small></article>
        <article><span>Assessment completion</span><strong>{percentage(summary?.assessmentCompletionRate)}</strong><small>{summary?.submissions || 0} of expected student submissions</small></article>
        <article><span>Average score</span><strong>{percentage(summary?.averageScore)}</strong><small>Across graded quiz and assignment submissions</small></article>
        <article className={summary?.atRiskStudents ? 'needs-attention' : ''}><span>Students to check in with</span><strong>{summary?.atRiskStudents ?? 0}</strong><small>Low completion or attendance in this scope</small></article>
      </div>

      <div className="portal-analysis-layout">
        <article className="portal-panel portal-analysis-subjects">
          <div className="portal-section-heading"><div><p className="portal-eyebrow">Course breakdown</p><h2>Subject performance</h2></div><span className="portal-section-count">{subjects.length} subjects</span></div>
          <div className="portal-analysis-table-wrap"><table className="portal-analysis-table"><thead><tr><th>Subject</th><th>Groups</th><th>Learners</th><th>Attendance</th><th>Completion</th><th>Average</th></tr></thead><tbody>
            {subjects.map((subject) => <tr key={subject.id}>
              <td><strong>{subject.name}</strong><small>{subject.code || subject.semesterName}</small><div className="portal-analysis-bars"><span style={{ width: `${subject.assessmentCompletionRate ?? 0}%` }} /><span className="attendance" style={{ width: `${subject.attendanceRate ?? 0}%` }} /></div></td>
              <td>{subject.teachingGroups}</td><td>{subject.students}</td><td>{percentage(subject.attendanceRate)}</td><td>{percentage(subject.assessmentCompletionRate)}</td><td>{percentage(subject.averageScore)}</td>
            </tr>)}
          </tbody></table></div>
          <div className="portal-analysis-legend"><span><i className="completion" /> Assessment completion</span><span><i className="attendance" /> Attendance</span></div>
        </article>

        <aside className="portal-panel portal-analysis-insights">
          <p className="portal-eyebrow">What needs attention</p><h2>Academic signals</h2>
          {!hasRecords ? <EmptyState title="Waiting for learning activity">Publish assessments and record attendance to build a useful analysis.</EmptyState> : <ul>
            {summary?.atRiskStudents > 0 && <li><strong>{summary.atRiskStudents} learners</strong><span>are below the attendance or assessment completion thresholds.</span></li>}
            {summary?.attendanceRate != null && summary.attendanceRate < 75 && <li><strong>Attendance is below 75%</strong><span>Review teaching groups with the lowest rates.</span></li>}
            {summary?.assessmentCompletionRate != null && summary.assessmentCompletionRate < 70 && <li><strong>Submission completion is below 70%</strong><span>Check deadlines, access, and follow-up for open assessments.</span></li>}
            {summary?.averageScore != null && summary.averageScore < 50 && <li><strong>Average score is below 50%</strong><span>Review course progress and offer targeted academic support.</span></li>}
            {!summary?.atRiskStudents && (summary?.attendanceRate == null || summary.attendanceRate >= 75) && (summary?.assessmentCompletionRate == null || summary.assessmentCompletionRate >= 70) && (summary?.averageScore == null || summary.averageScore >= 50) && <li><strong>Signals are within the current thresholds</strong><span>Continue monitoring attendance and assessment activity.</span></li>}
          </ul>}
          <small className="portal-analysis-note">{analysis?.riskDefinition} This report uses aggregate records; student names and written responses are excluded.</small>
        </aside>
      </div>

      <div className="portal-analysis-lower-grid">
        <article className="portal-panel portal-analysis-divisions">
          <div className="portal-section-heading"><div><p className="portal-eyebrow">Teaching group comparison</p><h2>Division performance</h2></div><span className="portal-section-count">{divisions.length} divisions</span></div>
          {divisions.length ? <div className="portal-division-list">{divisions.map((division) => <div className="portal-division-row" key={division.id}>
            <div className="portal-division-title"><strong>{division.name}</strong><small>{division.semesterName} · {division.students} learners · {division.teachingGroups} groups</small></div>
            <div className="portal-division-metric"><span>Attendance</span><strong>{percentage(division.attendanceRate)}</strong><i><b className="attendance" style={{ width: `${division.attendanceRate ?? 0}%` }} /></i></div>
            <div className="portal-division-metric"><span>Assessment completion</span><strong>{percentage(division.assessmentCompletionRate)}</strong><i><b style={{ width: `${division.assessmentCompletionRate ?? 0}%` }} /></i></div>
            <div className="portal-division-metric"><span>Average score</span><strong>{percentage(division.averageScore)}</strong><i><b className="score" style={{ width: `${division.averageScore ?? 0}%` }} /></i></div>
          </div>)}</div> : <EmptyState title="No teaching groups in this semester">Division comparison will appear after offerings and students are assigned.</EmptyState>}
        </article>
        <article className="portal-panel portal-score-distribution">
          <div className="portal-section-heading"><div><p className="portal-eyebrow">Graded assessments</p><h2>Score distribution</h2></div><span className="portal-section-count">{scoreCount} graded</span></div>
          {scoreCount ? <>
            <div className="portal-score-stack" role="img" aria-label={`${scoreBands.below40 || 0} scores below 40 percent, ${scoreBands.from40to59 || 0} scores from 40 to 59 percent, ${scoreBands.from60to79 || 0} scores from 60 to 79 percent, and ${scoreBands.atLeast80 || 0} scores of 80 percent or higher`}>
              <i className="band-low" style={{ width: `${(scoreBands.below40 / scoreCount) * 100}%` }} />
              <i className="band-mid" style={{ width: `${(scoreBands.from40to59 / scoreCount) * 100}%` }} />
              <i className="band-good" style={{ width: `${(scoreBands.from60to79 / scoreCount) * 100}%` }} />
              <i className="band-high" style={{ width: `${(scoreBands.atLeast80 / scoreCount) * 100}%` }} />
            </div>
            <ul className="portal-score-legend">
              <li><i className="band-low" /><span>Below 40%</span><strong>{scoreBands.below40 || 0}</strong></li>
              <li><i className="band-mid" /><span>40–59%</span><strong>{scoreBands.from40to59 || 0}</strong></li>
              <li><i className="band-good" /><span>60–79%</span><strong>{scoreBands.from60to79 || 0}</strong></li>
              <li><i className="band-high" /><span>80% and above</span><strong>{scoreBands.atLeast80 || 0}</strong></li>
            </ul>
          </> : <EmptyState title="No graded assessments yet">Scores will be grouped here when learners complete published quizzes or graded assignments.</EmptyState>}
        </article>
      </div>
    </>}
  </section>;
}

function CourseCard({ course, offering = false, teacher = '', onOpen }) {
  const title = offering ? course.subjectName : course.name;
  return (
    <article className="portal-course-card">
      <div className="portal-course-top"><span className="portal-course-symbol">{(course.code || title || 'C').slice(0, 1).toUpperCase()}</span><code>{course.code || 'COURSE'}</code></div>
      <h3>{title}</h3>
      <p>{course.programName || course.departmentName || 'MIT ADT University'}</p>
      <div className="portal-course-meta">
        {course.divisionName && <span>{course.divisionName}</span>}
        {(course.academicYearName || course.semesterName) && <span>{course.academicYearName || ''}{course.semesterNumber ? ` · Semester ${course.semesterNumber}` : ''}</span>}
      </div>
      {teacher && <div className="portal-course-teacher"><span>Subject teacher</span><strong>{teacher}</strong></div>}
      {onOpen && <button className="portal-course-open" type="button" onClick={onOpen}>Open course space <span>↗</span></button>}
    </article>
  );
}

function ContentCard({ item, studentSubmission, staffSubmissionCount, isStudent, canManageDrafts, onTake, onPublish, onEdit, publishing }) {
  const assessment = item.itemType === 'quiz' || item.itemType === 'assignment';
  return (
    <article className="portal-content-card">
      <div className={`portal-content-icon type-${item.itemType}`}>{item.itemType === 'quiz' ? '✓' : item.itemType === 'assignment' ? '▤' : item.itemType === 'resource' ? '↗' : '◉'}</div>
      <div className="portal-content-main">
        <div className="portal-content-title-row"><span className={`portal-type-pill type-${item.itemType}`}>{item.itemType}</span><span className={`portal-status-pill status-${item.status}`}>{item.status}</span></div>
        <h3>{item.title}</h3>
        <p className="portal-content-description">{item.description}</p>
        <div className="portal-content-meta">
          <span>{item.subjectName || item.offeringName}</span>
          {item.dueAt && <span>Due {formatDate(item.dueAt, true)}</span>}
          {assessment && <span>{item.itemType === 'quiz' ? `${item.questions?.length || 0} questions` : `${item.maxPoints} points`}</span>}
          {item.itemType === 'quiz' && <span>{item.maxPoints} points</span>}
          {!isStudent && assessment && <span>{staffSubmissionCount} submission{staffSubmissionCount === 1 ? '' : 's'}</span>}
        </div>
      </div>
      <div className="portal-content-actions">
        {isStudent && assessment && (studentSubmission
          ? <strong className="portal-submitted-badge">{studentSubmission.score == null ? 'Submitted' : `Score ${studentSubmission.score}/${studentSubmission.maxPoints}`}</strong>
          : <button className="portal-primary-button compact" type="button" onClick={() => onTake(item)}>{item.itemType === 'quiz' ? 'Start quiz' : 'Submit work'}</button>)}
        {!isStudent && canManageDrafts && item.status === 'draft' && <><button className="portal-secondary-button compact" type="button" onClick={() => onEdit(item)}>Edit draft</button><button className="portal-secondary-button compact" type="button" onClick={() => onPublish(item)} disabled={publishing}>{publishing ? 'Publishing…' : 'Publish'}</button></>}
        {item.itemType === 'resource' && item.resourceUrl && <a className="portal-secondary-button compact" href={item.resourceUrl} target="_blank" rel="noreferrer">Open resource ↗</a>}
      </div>
    </article>
  );
}

async function portalRequest(user, path, options = {}) {
  const token = await getAccessToken();
  const response = await fetch(apiUrl(path), {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const result = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'The learning workspace request could not be completed.');
  return result;
}

export default function RoleDashboard({ user, roleAssignments = [], onBack }) {
  const [selectedRoleId, setSelectedRoleId] = useState(roleAssignments[0]?.id || '');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [activeTab, setActiveTab] = useState('overview');
  const [courseFilterId, setCourseFilterId] = useState('');
  const [analysisSemesterId, setAnalysisSemesterId] = useState('all');
  const [composerOpen, setComposerOpen] = useState(false);
  const [editingItemId, setEditingItemId] = useState('');
  const [itemType, setItemType] = useState('quiz');
  const [selectedOfferingId, setSelectedOfferingId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [resourceUrl, setResourceUrl] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [maxPoints, setMaxPoints] = useState('100');
  const [publishNow, setPublishNow] = useState(true);
  const [questions, setQuestions] = useState([{ prompt: '', choices: ['', '', '', ''], answerIndex: 0, points: 1 }]);
  const [saving, setSaving] = useState('');
  const [selectedAssessment, setSelectedAssessment] = useState(null);
  const [assessmentAnswers, setAssessmentAnswers] = useState({});
  const [assignmentText, setAssignmentText] = useState('');
  const [grading, setGrading] = useState({});
  const [gradeDrafts, setGradeDrafts] = useState({});
  const [attendanceOfferingId, setAttendanceOfferingId] = useState('');
  const [attendanceDate, setAttendanceDate] = useState(todayInputValue);
  const [attendanceTitle, setAttendanceTitle] = useState('Class attendance');
  const [attendanceStatuses, setAttendanceStatuses] = useState({});
  const [editingAttendanceId, setEditingAttendanceId] = useState('');

  const selectedRole = useMemo(
    () => roleAssignments.find((role) => role.id === selectedRoleId) || roleAssignments[0],
    [roleAssignments, selectedRoleId],
  );

  useEffect(() => {
    let active = true;
    if (!user || !selectedRole?.id) {
      setLoading(false);
      setError('No active role is assigned to this account. Ask your administrator to assign your LMS role.');
      return () => { active = false; };
    }
    setLoading(true);
    setError('');
    setData(null);
    (async () => {
      try {
        const query = new URLSearchParams({ assignmentId: selectedRole.id });
        const result = await portalRequest(user, `/api/portal/dashboard?${query}`);
        if (active) setData(result);
      } catch (loadError) {
        if (active) {
          setData(null);
          setError(loadError.message || 'Your learning workspace could not be loaded.');
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [user, selectedRole?.id, refreshVersion]);

  useEffect(() => {
    const offerings = data?.offerings || [];
    if (offerings.length && !offerings.some((offering) => offering.id === selectedOfferingId)) {
      setSelectedOfferingId(offerings[0].id);
    }
  }, [data, selectedOfferingId]);

  useEffect(() => {
    const offerings = data?.offerings || [];
    if (offerings.length && !offerings.some((offering) => offering.id === attendanceOfferingId)) {
      setAttendanceOfferingId(offerings[0].id);
    } else if (!offerings.length && attendanceOfferingId) {
      setAttendanceOfferingId('');
    }
  }, [data, attendanceOfferingId]);

  useEffect(() => {
    const semesters = data?.analysis?.semesters || [];
    if (analysisSemesterId !== 'all' && !semesters.some((semester) => semester.id === analysisSemesterId)) {
      setAnalysisSemesterId('all');
    }
  }, [data, analysisSemesterId]);

  const role = data?.scope?.role || selectedRole?.role || 'student';
  const viewMatches = data?.scope?.id === selectedRole?.id;
  const information = roleInfo[role] || roleInfo.student;
  const context = data?.context || {};
  const counts = data?.counts || {};
  const capabilities = data?.capabilities || {};
  const isStudent = role === 'student';
  const isManager = ['school_admin', 'dean', 'hod'].includes(role);
  const scopeTitle = context.school?.name || context.department?.name || context.subject?.name || context.offering?.subjectName || context.division?.name || selectedRole?.scopeName || 'University workspace';
  const offerings = data?.offerings || EMPTY_LIST;
  const subjects = data?.subjects || EMPTY_LIST;
  const courseItems = isManager ? subjects : offerings;
  const people = data?.people || EMPTY_LIST;
  const items = data?.items || EMPTY_LIST;
  const submissions = data?.submissions || EMPTY_LIST;
  const attendanceSessions = data?.attendance || EMPTY_LIST;
  const attendanceOffering = offerings.find((offering) => offering.id === attendanceOfferingId);
  const attendanceRoster = useMemo(() => people
    .filter((person) => person.role === 'student' && attendanceOffering
      && (person.scopeId === attendanceOffering.divisionId || person.divisionId === attendanceOffering.divisionId))
    .sort((a, b) => String(a.displayName).localeCompare(String(b.displayName))), [people, attendanceOffering]);
  const attendanceSummary = useMemo(() => summarizeAttendance(attendanceSessions), [attendanceSessions]);

  useEffect(() => {
    const editingSession = attendanceSessions.find((session) => session.id === editingAttendanceId);
    const currentStatuses = new Map((editingSession?.records || []).map((record) => [record.uid, record.status]));
    setAttendanceStatuses(Object.fromEntries(attendanceRoster.map((student) => [student.uid, currentStatuses.get(student.uid) || 'present'])));
  }, [attendanceRoster, attendanceSessions, editingAttendanceId]);
  const submissionByItem = useMemo(() => new Map(submissions.map((submission) => [submission.itemId, submission])), [submissions]);
  const submissionsByItem = useMemo(() => {
    const grouped = new Map();
    submissions.forEach((submission) => grouped.set(submission.itemId, [...(grouped.get(submission.itemId) || []), submission]));
    return grouped;
  }, [submissions]);
  const assessments = items.filter((item) => ['quiz', 'assignment'].includes(item.itemType));
  const visibleAssessments = courseFilterId
    ? assessments.filter((item) => (isManager ? item.subjectId : item.offeringId) === courseFilterId)
    : assessments;
  const resources = items.filter((item) => item.itemType === 'resource');
  const announcements = items.filter((item) => item.itemType === 'announcement');
  const courseTitle = isManager ? 'Subject portfolio' : isStudent ? 'My subjects this semester' : role === 'subject_coordinator' ? 'Coordinated teaching groups' : 'My teaching groups';
  const sortedPrograms = sortByName(data?.programs);

  const stats = isManager ? [
    { label: 'Programs', value: counts.programs || 0, detail: 'Active cohorts in scope', icon: '↗' },
    { label: 'Subjects', value: counts.subjects || 0, detail: 'Across academic semesters', icon: '▤' },
    { label: 'Divisions', value: counts.divisions || 0, detail: 'Teaching groups', icon: '◎' },
    { label: 'Students', value: counts.students || 0, detail: 'Assigned learners', icon: '♧' },
  ] : isStudent ? [
    { label: 'My subjects', value: subjects.length, detail: 'In this semester', icon: '▤' },
    { label: 'My division', value: context.division?.code || '—', detail: context.division?.name || 'Not assigned', icon: '◎' },
    { label: 'Open assessments', value: assessments.filter((item) => !submissionByItem.has(item.id)).length, detail: 'Quizzes and assignments', icon: '✓' },
    { label: 'Resources', value: resources.length, detail: 'Shared with your classes', icon: '▧' },
  ] : [
    { label: role === 'subject_teacher' ? 'Assigned groups' : 'Divisions', value: role === 'subject_teacher' ? offerings.length : counts.divisions || 0, detail: 'In your workspace', icon: '◎' },
    { label: 'Assessments', value: assessments.length, detail: 'Quizzes and assignments', icon: '✓' },
    { label: 'Pending review', value: submissions.filter((submission) => submission.status !== 'graded' && submission.itemType === 'assignment').length, detail: 'Written submissions', icon: '◷' },
    { label: 'Resources', value: resources.length, detail: 'Shared with your classes', icon: '▧' },
  ];

  const tabs = [
    ...roleTabs,
    ...(capabilities.viewAnalysis ? [{ id: 'analysis', label: 'Academic analysis', icon: '▥' }] : []),
    ...(capabilities.viewAttendance ? [{ id: 'attendance', label: 'Attendance', icon: '◷' }] : []),
    ...(capabilities.viewGradebook ? [{ id: 'gradebook', label: isStudent ? 'My results' : 'Gradebook', icon: '▦' }] : []),
    ...(!isStudent ? [{ id: 'people', label: isManager ? 'People & roles' : role === 'subject_coordinator' ? 'Teaching team' : 'My class', icon: '♧' }] : []),
    ...((isManager || role === 'subject_coordinator') ? [{ id: 'structure', label: 'Academic structure', icon: '⌘' }] : []),
  ];

  async function refreshAfterAction() {
    setRefreshVersion((version) => version + 1);
  }

  async function handleSignOut() {
    if (supabase) await supabase.auth.signOut();
    onBack();
  }

  function openComposer(type = 'quiz') {
    const allowedType = capabilities.createCourseContent ? type : 'announcement';
    setItemType(allowedType);
    setComposerOpen(true);
    setCourseFilterId('');
    setError('');
    setNotice('');
    setActiveTab(allowedType === 'resource' ? 'resources' : allowedType === 'announcement' ? 'announcements' : 'assessments');
  }

  function resetComposer() {
    setTitle('');
    setDescription('');
    setResourceUrl('');
    setDueAt('');
    setMaxPoints('100');
    setQuestions([{ prompt: '', choices: ['', '', '', ''], answerIndex: 0, points: 1 }]);
    setPublishNow(true);
    setEditingItemId('');
    setComposerOpen(false);
  }

  function editDraft(item) {
    setEditingItemId(item.id);
    setItemType(item.itemType);
    setSelectedOfferingId(item.offeringId);
    setTitle(item.title || '');
    setDescription(item.description || '');
    setResourceUrl(item.resourceUrl || '');
    setDueAt(item.dueAt ? (() => {
      const date = new Date(item.dueAt);
      return Number.isNaN(date.getTime()) ? '' : new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    })() : '');
    setMaxPoints(String(item.maxPoints || 100));
    setPublishNow(false);
    setQuestions(item.questions?.length ? item.questions.map((question) => ({ ...question, choices: [...question.choices], answerIndex: question.answerIndex ?? 0 })) : [{ prompt: '', choices: ['', '', '', ''], answerIndex: 0, points: 1 }]);
    setComposerOpen(true);
    setError('');
    setNotice('');
    setActiveTab(item.itemType === 'resource' ? 'resources' : item.itemType === 'announcement' ? 'announcements' : 'assessments');
  }

  function updateQuestion(index, key, value) {
    setQuestions((current) => current.map((question, questionIndex) => questionIndex === index
      ? { ...question, [key]: value }
      : question));
  }

  function updateChoice(questionIndex, choiceIndex, value) {
    setQuestions((current) => current.map((question, index) => index === questionIndex
      ? { ...question, choices: question.choices.map((choice, optionIndex) => optionIndex === choiceIndex ? value : choice) }
      : question));
  }

  async function submitContent(event) {
    event.preventDefault();
    setSaving('content');
    setError('');
    setNotice('');
    try {
      if (!selectedOfferingId) throw new Error('Choose a teaching group for this content.');
      const payload = {
        itemType,
        offeringId: selectedOfferingId,
        title,
        description,
        status: publishNow ? 'published' : 'draft',
        ...(dueAt ? { dueAt: new Date(dueAt).toISOString() } : {}),
        ...(itemType === 'resource' ? { resourceUrl } : {}),
        ...(itemType === 'assignment' ? { maxPoints: Number(maxPoints) } : {}),
        ...(itemType === 'quiz' ? { questions: questions.map((question) => ({ ...question, points: Number(question.points), answerIndex: Number(question.answerIndex) })) } : {}),
      };
      await portalRequest(user, editingItemId ? `/api/portal/items/${encodeURIComponent(editingItemId)}` : '/api/portal/items', {
        method: editingItemId ? 'PATCH' : 'POST',
        body: JSON.stringify(payload),
      });
      setNotice(publishNow ? 'Your course item is published.' : 'Your draft is saved. Publish it when it is ready.');
      resetComposer();
      await refreshAfterAction();
    } catch (actionError) {
      setError(actionError.message || 'The course item could not be created.');
    } finally {
      setSaving('');
    }
  }

  async function publishItem(item) {
    setSaving(`publish:${item.id}`);
    setError('');
    setNotice('');
    try {
      await portalRequest(user, `/api/portal/items/${encodeURIComponent(item.id)}/publish`, { method: 'POST' });
      setNotice(`${item.title} is now published.`);
      await refreshAfterAction();
    } catch (actionError) {
      setError(actionError.message || 'The item could not be published.');
    } finally {
      setSaving('');
    }
  }

  function openAssessment(item) {
    setSelectedAssessment(item);
    setAssessmentAnswers({});
    setAssignmentText('');
    setError('');
    setNotice('');
  }

  async function submitAssessment(event) {
    event.preventDefault();
    if (!selectedAssessment) return;
    setSaving(`submit:${selectedAssessment.id}`);
    setError('');
    try {
      let payload;
      if (selectedAssessment.itemType === 'quiz') {
        const answers = selectedAssessment.questions.map((question) => assessmentAnswers[question.id]);
        if (answers.some((answer) => answer === undefined)) throw new Error('Answer every question before submitting the quiz.');
        payload = { answers };
      } else {
        if (assignmentText.trim().length < 2) throw new Error('Enter your assignment response before submitting.');
        payload = { answerText: assignmentText };
      }
      await portalRequest(user, `/api/portal/items/${encodeURIComponent(selectedAssessment.id)}/submissions`, {
        method: 'POST', body: JSON.stringify(payload),
      });
      setSelectedAssessment(null);
      setNotice('Your submission was received.');
      await refreshAfterAction();
    } catch (actionError) {
      setError(actionError.message || 'Your submission could not be saved.');
    } finally {
      setSaving('');
    }
  }

  async function gradeSubmission(submission) {
    const draft = gradeDrafts[submission.id] || {};
    setGrading((current) => ({ ...current, [submission.id]: true }));
    setError('');
    setNotice('');
    try {
      await portalRequest(user, `/api/portal/submissions/${encodeURIComponent(submission.id)}/grade`, {
        method: 'PATCH',
        body: JSON.stringify({ score: Number(draft.score), feedback: draft.feedback || '' }),
      });
      setNotice(`Saved grade for ${submission.studentName || 'student'}.`);
      await refreshAfterAction();
    } catch (actionError) {
      setError(actionError.message || 'The grade could not be saved.');
    } finally {
      setGrading((current) => ({ ...current, [submission.id]: false }));
    }
  }

  async function recordAttendance(event) {
    event.preventDefault();
    if (!attendanceOffering || !attendanceRoster.length) {
      setError('Choose a teaching group with an assigned student roster.');
      return;
    }
    setSaving('attendance');
    setError('');
    setNotice('');
    try {
      const records = attendanceRoster.map((student) => ({
        uid: student.uid,
        status: attendanceStatuses[student.uid] || 'present',
      }));
      await portalRequest(user, editingAttendanceId
        ? `/api/portal/attendance/${encodeURIComponent(editingAttendanceId)}`
        : '/api/portal/attendance', {
        method: editingAttendanceId ? 'PATCH' : 'POST',
        body: JSON.stringify({
          offeringId: attendanceOffering.id,
          sessionDate: attendanceDate,
          title: attendanceTitle,
          records,
        }),
      });
      setNotice(`${editingAttendanceId ? 'Attendance updated' : 'Attendance saved'} for ${attendanceOffering.subjectName} on ${formatDate(`${attendanceDate}T00:00:00`)}.`);
      setEditingAttendanceId('');
      setAttendanceDate(todayInputValue());
      setAttendanceTitle('Class attendance');
      await refreshAfterAction();
    } catch (actionError) {
      setError(actionError.message || 'Attendance could not be saved.');
    } finally {
      setSaving('');
    }
  }

  function beginAttendanceEdit(session) {
    const offering = offerings.find((entry) => entry.id === session.offeringId);
    if (!offering) return;
    setAttendanceOfferingId(offering.id);
    setAttendanceDate(session.sessionDate || todayInputValue());
    setAttendanceTitle(session.title || 'Class attendance');
    setEditingAttendanceId(session.id);
    setActiveTab('attendance');
    setError('');
    setNotice('');
    window.requestAnimationFrame(() => document.querySelector('.portal-attendance-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  function cancelAttendanceEdit() {
    setEditingAttendanceId('');
    setAttendanceDate(todayInputValue());
    setAttendanceTitle('Class attendance');
  }

  const dateLabel = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }).format(new Date());
  const visibleCourseItems = isManager ? subjects : offerings;
  const upcomingItems = assessments.filter((item) => item.status === 'published' && item.dueAt && new Date(item.dueAt) >= new Date()).sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt)).slice(0, 4);
  const latestUpdates = [...announcements, ...resources].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).slice(0, 4);
  const programSemestersFor = (program) => (data?.semesters || []).filter((semester) => semester.programId === program.id).sort((a, b) => (a.yearNumber - b.yearNumber) || (a.semesterNumber - b.semesterNumber));

  return (
    <main className="portal-page">
      <aside className="portal-sidebar">
        <a className="portal-brand" href="#portal-overview" aria-label="MIT ADT LMS workspace">
          <span className="portal-brand-mark">M</span><span><strong>MIT ADT LMS</strong><small>Learning workspace</small></span>
        </a>
        <div className="portal-sidebar-role"><span className="portal-avatar">{(user.displayName || user.email || 'U').slice(0, 1).toUpperCase()}</span><span><strong>{information.title}</strong><small>{scopeTitle}</small></span></div>
        <nav className="portal-nav" aria-label="Workspace navigation">
          {tabs.map((tab) => <button key={tab.id} className={activeTab === tab.id ? 'active' : ''} type="button" onClick={() => { setActiveTab(tab.id); setComposerOpen(false); }}><span>{tab.icon}</span>{tab.label}</button>)}
        </nav>
        <div className="portal-sidebar-bottom">
          <div className="portal-sidebar-note"><span>✦</span><strong>Keep learning moving</strong><p>Your workspace brings together the academic areas assigned to your account.</p></div>
          <button type="button" onClick={handleSignOut} className="portal-signout"><span>↗</span> Sign out</button>
        </div>
      </aside>

      <section className="portal-main">
        <header className="portal-topbar">
          <div className="portal-breadcrumb"><span>MIT ADT University</span><b>/</b><strong>{information.title}</strong></div>
          <div className="portal-top-actions">
            {roleAssignments.length > 1 && <label className="portal-role-picker"><span>Workspace</span><select value={selectedRoleId} onChange={(event) => { resetComposer(); setCourseFilterId(''); setSelectedRoleId(event.target.value); setActiveTab('overview'); }} aria-label="Choose your workspace">{roleAssignments.map((assignment) => <option key={assignment.id} value={assignment.id}>{assignment.roleLabel || information.title} · {assignment.scopeName || 'Assigned scope'}</option>)}</select></label>}
            <span className="portal-user-pill"><span>{(user.displayName || user.email || 'U').slice(0, 1).toUpperCase()}</span>{user.displayName || user.email}</span>
            {capabilities.createCourseContent && <button className="portal-primary-button top-create" type="button" onClick={() => openComposer('quiz')}>＋ Create</button>}
            {capabilities.postAnnouncements && !capabilities.createCourseContent && <button className="portal-primary-button top-create" type="button" onClick={() => openComposer('announcement')}>＋ Notice</button>}
            <button className="portal-refresh" type="button" onClick={() => setRefreshVersion((version) => version + 1)} disabled={loading} aria-label="Refresh workspace">⟳</button>
            <button className="portal-mobile-signout" type="button" onClick={handleSignOut}>Sign out</button>
          </div>
        </header>

        <div className="portal-content" id="portal-overview">
          {error && <div className="portal-alert" role="alert">{error}<button type="button" onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
          {notice && <div className="portal-notice" role="status">{notice}<button type="button" onClick={() => setNotice('')} aria-label="Dismiss notice">×</button></div>}
          <div className="portal-welcome-row">
            <div><p className="portal-eyebrow">{information.title} workspace</p><h1>{greeting()}, {user.displayName?.split(' ')[0] || 'welcome'}.</h1><p>{information.copy}</p></div>
            <div className="portal-date-card"><span>Today</span><strong>{dateLabel}</strong><small>{scopeTitle}</small></div>
          </div>

          {loading || (data && !viewMatches) ? <div className="portal-loading"><span className="portal-spinner" />Loading your assigned workspace…</div> : data && viewMatches && <>
            {activeTab === 'overview' && <>
              <section className={`portal-hero portal-hero-${role}`}>
                <div className="portal-hero-content"><span className="portal-hero-label">{scopeTitle}</span><h2>{information.headline}</h2><p>{context.program?.name || context.offering?.programName || context.division?.programName || context.department?.name || 'Your MIT ADT academic space'}</p></div>
                <div className="portal-hero-orbit" aria-hidden="true"><span>MIT<br /><b>ADT</b></span></div>
                <div className="portal-hero-foot"><span>Academic workspace</span><strong>{context.semester?.academicYearName || context.offering?.academicYearName || (context.program ? `${context.program.intakeYear}–${context.program.graduationYear}` : 'MIT ADT University')}</strong></div>
              </section>
              <section className="portal-stats" aria-label="Workspace summary">{stats.map((stat) => <StatCard key={stat.label} {...stat} />)}</section>
              <section className="portal-overview-grid">
                <article className="portal-panel"><div className="portal-section-heading"><div><p className="portal-eyebrow">Stay on track</p><h2>Upcoming assessments</h2></div><button type="button" onClick={() => setActiveTab('assessments')}>View all ↗</button></div>
                  {upcomingItems.length ? <div className="portal-upcoming-list">{upcomingItems.map((item) => <button type="button" key={item.id} onClick={() => setActiveTab('assessments')}><span className={`portal-upcoming-icon type-${item.itemType}`}>{item.itemType === 'quiz' ? '✓' : '▤'}</span><span><strong>{item.title}</strong><small>{item.subjectName} · Due {formatDate(item.dueAt, true)}</small></span><b>›</b></button>)}</div> : <EmptyState title="You’re all caught up">Published quizzes and assignments with upcoming due dates will appear here.</EmptyState>}
                </article>
                <article className="portal-panel"><div className="portal-section-heading"><div><p className="portal-eyebrow">From your courses</p><h2>Recent updates</h2></div><button type="button" onClick={() => setActiveTab('announcements')}>Announcements ↗</button></div>
                  {latestUpdates.length ? <div className="portal-update-list">{latestUpdates.map((item) => <div className="portal-update-row" key={item.id}><span className={`portal-update-dot type-${item.itemType}`} /><div><strong>{item.title}</strong><small>{item.subjectName} · {item.itemType} · {formatDate(item.createdAt)}</small><p>{item.description}</p></div></div>)}</div> : <EmptyState title="Nothing new has been posted">Course notices and shared resources will show here.</EmptyState>}
                </article>
              </section>
            </>}

            {activeTab === 'analysis' && capabilities.viewAnalysis && <AnalysisPanel
              analysis={data.analysis}
              semesters={data.analysis?.semesters || []}
              selectedSemesterId={analysisSemesterId}
              onSemesterChange={setAnalysisSemesterId}
              role={role}
            />}

            {activeTab === 'courses' && <section className="portal-tab-panel">
              <div className="portal-tab-heading"><div><p className="portal-eyebrow">Learning space</p><h2>{courseTitle}</h2><p>Your teaching groups and subject spaces for the selected role.</p></div>{capabilities.createCourseContent && <button className="portal-primary-button" type="button" onClick={() => openComposer('quiz')}>＋ Create course content</button>}</div>
              {visibleCourseItems.length ? <div className="portal-course-grid">{visibleCourseItems.map((course) => {
                const teacher = isManager
                  ? people.find((person) => person.role === 'subject_teacher' && person.subjectId === course.id)?.displayName
                  : people.find((person) => person.role === 'subject_teacher' && person.scopeId === course.id)?.displayName;
                return <CourseCard key={course.id} course={course} offering={!isManager} teacher={teacher || ''} onOpen={() => { setCourseFilterId(course.id); setActiveTab('assessments'); setComposerOpen(false); }} />;
              })}</div> : <EmptyState title="No course spaces are assigned yet">Ask your administrator to connect a subject offering to your account.</EmptyState>}
            </section>}

            {activeTab === 'assessments' && <section className="portal-tab-panel">
              <div className="portal-tab-heading"><div><p className="portal-eyebrow">Assessment centre</p><h2>{isStudent ? 'Quizzes & assignments' : 'Quizzes and assignments'}</h2><p>{isStudent ? 'Take quizzes and submit written work for your assigned courses.' : 'Create assessments, publish drafts, and review incoming work.'}</p></div>{capabilities.createCourseContent && <button className="portal-primary-button" type="button" onClick={() => openComposer('quiz')}>＋ Create assessment</button>}</div>
              {composerOpen && ['quiz', 'assignment'].includes(itemType) && <ContentComposer {...{ offerings, selectedOfferingId, setSelectedOfferingId, itemType, setItemType, title, setTitle, description, setDescription, resourceUrl, setResourceUrl, dueAt, setDueAt, maxPoints, setMaxPoints, publishNow, setPublishNow, questions, setQuestions, updateQuestion, updateChoice, saving, onSubmit: submitContent, onCancel: resetComposer, capabilities, editing: Boolean(editingItemId) }} />}
              {courseFilterId && <div className="portal-filter-chip"><span>Showing assessments for {isManager ? subjects.find((subject) => subject.id === courseFilterId)?.name || 'selected subject' : offerings.find((offering) => offering.id === courseFilterId)?.subjectName || 'selected course'}</span><button type="button" onClick={() => setCourseFilterId('')}>Clear filter ×</button></div>}
              {visibleAssessments.length ? <div className="portal-content-list">{visibleAssessments.map((item) => <ContentCard key={item.id} item={item} studentSubmission={submissionByItem.get(item.id)} staffSubmissionCount={(submissionsByItem.get(item.id) || []).length || data?.submissionCounts?.[item.id] || 0} isStudent={isStudent} canManageDrafts={capabilities.createCourseContent || capabilities.postAnnouncements} onTake={openAssessment} onPublish={publishItem} onEdit={editDraft} publishing={saving === `publish:${item.id}`} />)}</div> : <EmptyState title={courseFilterId ? 'No assessments for this course yet' : 'No assessments yet'}>New quizzes and assignments for this academic scope will appear here.</EmptyState>}
            </section>}

            {activeTab === 'attendance' && <section className="portal-tab-panel">
              <div className="portal-tab-heading"><div><p className="portal-eyebrow">Class register</p><h2>{isStudent ? 'My attendance' : 'Attendance register'}</h2><p>{isStudent ? 'Review the attendance recorded for your classes.' : 'Record a class session and review past attendance registers.'}</p></div></div>
              {isStudent ? <>
                <div className="portal-attendance-summary">
                  <article><span>Attendance rate</span><strong>{attendanceSummary.percentage == null ? '—' : `${attendanceSummary.percentage}%`}</strong><small>Present and late, excused sessions excluded</small></article>
                  <article><span>Present</span><strong>{attendanceSummary.present}</strong><small>Sessions recorded</small></article>
                  <article><span>Late</span><strong>{attendanceSummary.late}</strong><small>Sessions recorded</small></article>
                  <article><span>Absent</span><strong>{attendanceSummary.absent}</strong><small>Sessions recorded</small></article>
                </div>
                {attendanceSessions.length ? <div className="portal-attendance-history">{attendanceSessions.map((session) => <article className="portal-attendance-session" key={session.id}><div className="portal-attendance-session-heading"><div><strong>{session.title || 'Class attendance'}</strong><small>{session.subjectName || session.offeringName} · {session.divisionName || context.division?.name}</small></div><span className={`portal-attendance-status status-${session.records?.[0]?.status || 'unknown'}`}>{session.records?.[0]?.status || 'Not recorded'}</span></div><p>{formatDate(`${session.sessionDate}T00:00:00`)}{session.records?.[0]?.status === 'excused' ? ' · Excused absence' : ''}</p></article>)}</div> : <EmptyState title="No attendance has been recorded">Your class attendance will appear here after your teacher records a session.</EmptyState>}
              </> : <>
                <div className="portal-attendance-summary compact-summary">
                  <article><span>Recorded sessions</span><strong>{attendanceSummary.sessions}</strong><small>In your assigned teaching groups</small></article>
                  <article><span>Present</span><strong>{attendanceSummary.present}</strong><small>Student records</small></article>
                  <article><span>Absent</span><strong>{attendanceSummary.absent}</strong><small>Student records</small></article>
                  <article><span>Late / excused</span><strong>{attendanceSummary.late + attendanceSummary.excused}</strong><small>Student records</small></article>
                </div>
                {capabilities.markAttendance && <form className="portal-attendance-form" onSubmit={recordAttendance}>
                  <div className="portal-section-heading"><div><p className="portal-eyebrow">{editingAttendanceId ? 'Correction' : 'New register'}</p><h3>{editingAttendanceId ? 'Correct attendance register' : 'Record attendance'}</h3></div><span className="portal-section-count">{attendanceRoster.length} students</span></div>
                  <div className="portal-attendance-fields">
                    <label>Teaching group<select value={attendanceOfferingId} onChange={(event) => setAttendanceOfferingId(event.target.value)} required disabled={Boolean(editingAttendanceId)}><option value="">Choose a teaching group</option>{offerings.map((offering) => <option key={offering.id} value={offering.id}>{offering.subjectName} · {offering.divisionName}</option>)}</select></label>
                    <label>Class date<input type="date" value={attendanceDate} max={todayInputValue()} onChange={(event) => setAttendanceDate(event.target.value)} required disabled={Boolean(editingAttendanceId)} /></label>
                    <label>Session label<input value={attendanceTitle} onChange={(event) => setAttendanceTitle(event.target.value)} maxLength="120" required /></label>
                  </div>
                  {attendanceRoster.length ? <div className="portal-attendance-roster"><div className="portal-attendance-roster-head"><span>Student</span><span>Attendance status</span></div>{attendanceRoster.map((student, index) => <label className="portal-attendance-row" key={`${student.uid}:${index}`}><span className="portal-person"><span className="portal-person-avatar">{(student.displayName || 'S').slice(0, 1).toUpperCase()}</span><strong>{student.displayName || 'Student'}</strong></span><select value={attendanceStatuses[student.uid] || 'present'} onChange={(event) => setAttendanceStatuses((current) => ({ ...current, [student.uid]: event.target.value }))} aria-label={`Attendance status for ${student.displayName}`}><option value="present">Present</option><option value="absent">Absent</option><option value="late">Late</option><option value="excused">Excused</option></select></label>)}</div> : <EmptyState title={attendanceOffering ? 'No students found in this roster' : 'Choose a teaching group'}>Student roles need to be assigned to the selected division before attendance can be recorded.</EmptyState>}
                  <div className="portal-attendance-form-footer"><small>{editingAttendanceId ? 'Changes are recorded in the audit log.' : 'One register per teaching group and date. You can correct saved registers later.'}</small><div>{editingAttendanceId && <button className="portal-secondary-button" type="button" onClick={cancelAttendanceEdit}>Cancel</button>}<button className="portal-primary-button" type="submit" disabled={!attendanceRoster.length || saving === 'attendance'}>{saving === 'attendance' ? 'Saving register…' : editingAttendanceId ? 'Update attendance' : 'Save attendance'}</button></div></div>
                </form>}
                <div className="portal-attendance-history-heading"><div><p className="portal-eyebrow">Recent records</p><h3>Attendance history</h3></div></div>
                {attendanceSessions.length ? <div className="portal-attendance-history">{attendanceSessions.map((session) => {
                  const summary = summarizeAttendance([{ records: session.records || [] }]);
                  return <article className="portal-attendance-session" key={session.id}><div className="portal-attendance-session-heading"><div><strong>{session.title || 'Class attendance'}</strong><small>{session.subjectName || session.offeringName} · {session.divisionName}</small></div><div className="portal-attendance-session-actions"><span className="portal-section-count">{formatDate(`${session.sessionDate}T00:00:00`)}</span>{capabilities.markAttendance && offerings.some((offering) => offering.id === session.offeringId) && <button type="button" className="portal-secondary-button compact" onClick={() => beginAttendanceEdit(session)}>Edit register</button>}</div></div><div className="portal-attendance-counts"><span>{summary.present} present</span><span>{summary.absent} absent</span><span>{summary.late} late</span><span>{summary.excused} excused</span></div>{!isManager && <details><summary>View class register ({session.records?.length || 0})</summary><div className="portal-attendance-register">{(session.records || []).map((record) => <div key={record.uid}><span>{record.displayName || 'Student'}</span><span className={`portal-attendance-status status-${record.status}`}>{record.status}</span></div>)}</div></details>}</article>;
                })}</div> : <EmptyState title="No attendance sessions yet">Saved registers for your assigned teaching groups will appear here.</EmptyState>}
              </>}
            </section>}

            {activeTab === 'resources' && <section className="portal-tab-panel">
              <div className="portal-tab-heading"><div><p className="portal-eyebrow">Course library</p><h2>Resources</h2><p>Reference links and learning material shared by your teaching team.</p></div>{capabilities.createCourseContent && <button className="portal-primary-button" type="button" onClick={() => openComposer('resource')}>＋ Add resource</button>}</div>
              {composerOpen && itemType === 'resource' && <ContentComposer {...{ offerings, selectedOfferingId, setSelectedOfferingId, itemType, setItemType, title, setTitle, description, setDescription, resourceUrl, setResourceUrl, dueAt, setDueAt, maxPoints, setMaxPoints, publishNow, setPublishNow, questions, setQuestions, updateQuestion, updateChoice, saving, onSubmit: submitContent, onCancel: resetComposer, capabilities, editing: Boolean(editingItemId) }} />}
              {resources.length ? <div className="portal-content-list">{resources.map((item) => <ContentCard key={item.id} item={item} isStudent={isStudent} canManageDrafts={capabilities.createCourseContent || capabilities.postAnnouncements} onPublish={publishItem} onEdit={editDraft} publishing={saving === `publish:${item.id}`} />)}</div> : <EmptyState title="Your course library is empty">Teachers and coordinators can add trusted HTTPS links to course resources.</EmptyState>}
            </section>}

            {activeTab === 'announcements' && <section className="portal-tab-panel">
              <div className="portal-tab-heading"><div><p className="portal-eyebrow">Course notices</p><h2>Announcements</h2><p>Updates posted to your assigned classes and teaching groups.</p></div>{(capabilities.createCourseContent || capabilities.postAnnouncements) && <button className="portal-primary-button" type="button" onClick={() => openComposer('announcement')}>＋ Post announcement</button>}</div>
              {composerOpen && itemType === 'announcement' && <ContentComposer {...{ offerings, selectedOfferingId, setSelectedOfferingId, itemType, setItemType, title, setTitle, description, setDescription, resourceUrl, setResourceUrl, dueAt, setDueAt, maxPoints, setMaxPoints, publishNow, setPublishNow, questions, setQuestions, updateQuestion, updateChoice, saving, onSubmit: submitContent, onCancel: resetComposer, capabilities, editing: Boolean(editingItemId) }} />}
              {announcements.length ? <div className="portal-content-list">{announcements.map((item) => <ContentCard key={item.id} item={item} isStudent={isStudent} canManageDrafts={capabilities.createCourseContent || capabilities.postAnnouncements} onPublish={publishItem} onEdit={editDraft} publishing={saving === `publish:${item.id}`} />)}</div> : <EmptyState title="No announcements have been posted">New course announcements will appear here.</EmptyState>}
            </section>}

            {activeTab === 'gradebook' && <section className="portal-tab-panel">
              <div className="portal-tab-heading"><div><p className="portal-eyebrow">Assessment results</p><h2>{isStudent ? 'My results & submissions' : 'Gradebook and submissions'}</h2><p>{isStudent ? 'Your quiz scores, assignment status, and instructor feedback.' : 'Review learner submissions and record assignment grades.'}</p></div></div>
              {submissions.length ? isStudent ? <div className="portal-grade-grid">{submissions.map((submission) => <article className="portal-grade-card" key={submission.id}><div><span className={`portal-type-pill type-${submission.itemType}`}>{submission.itemType}</span><span className={`portal-status-pill status-${submission.status}`}>{submission.status}</span></div><h3>{submission.itemTitle}</h3><p>Submitted {formatDate(submission.submittedAt, true)}</p><strong className="portal-grade-score">{submission.score == null ? 'Awaiting review' : `${submission.score} / ${submission.maxPoints}`}</strong>{submission.feedback && <blockquote>{submission.feedback}</blockquote>}</article>)}</div> : <div className="portal-submission-list">{submissions.map((submission) => <article className="portal-submission-card" key={submission.id}><div className="portal-submission-summary"><span className="portal-person-avatar">{(submission.studentName || 'S').slice(0, 1).toUpperCase()}</span><div><strong>{submission.studentName || 'Student'}</strong><small>{submission.itemTitle} · {formatDate(submission.submittedAt, true)}</small></div><span className={`portal-status-pill status-${submission.status}`}>{submission.status}</span></div><div className="portal-submission-response">{submission.itemType === 'quiz' ? <p>Quiz graded automatically: <strong>{submission.score} / {submission.maxPoints}</strong></p> : <><p>{submission.answerText}</p>{submission.score != null && <p>Current grade: <strong>{submission.score} / {submission.maxPoints}</strong></p>}</>}</div>
                {!isStudent && submission.itemType === 'assignment' && <form className="portal-grade-form" onSubmit={(event) => { event.preventDefault(); gradeSubmission(submission); }}><label>Score<input type="number" min="0" max={submission.maxPoints} value={gradeDrafts[submission.id]?.score ?? submission.score ?? ''} onChange={(event) => setGradeDrafts((current) => ({ ...current, [submission.id]: { ...current[submission.id], score: event.target.value } }))} required /></label><label>Feedback<textarea rows="2" maxLength="2000" value={gradeDrafts[submission.id]?.feedback ?? submission.feedback ?? ''} onChange={(event) => setGradeDrafts((current) => ({ ...current, [submission.id]: { ...current[submission.id], feedback: event.target.value } }))} placeholder="Add feedback for the learner" /></label><button className="portal-primary-button compact" disabled={Boolean(grading[submission.id])}>{grading[submission.id] ? 'Saving…' : 'Save grade'}</button></form>}
              </article>)}</div> : <EmptyState title={isStudent ? 'No results yet' : 'No submissions to review'}>{isStudent ? 'Your quiz scores and assignment feedback will appear here after you submit your work.' : 'Student submissions will appear here as learners complete published assessments.'}</EmptyState>}
            </section>}

            {activeTab === 'people' && <section className="portal-tab-panel">
              <div className="portal-tab-heading"><div><p className="portal-eyebrow">Your community</p><h2>{isManager ? 'People in your scope' : role === 'subject_coordinator' ? 'Teaching team' : 'Class and learners'}</h2><p>People connected to this school, department, subject, or division.</p></div><span className="portal-section-count">{people.length} person{people.length === 1 ? '' : 's'}</span></div>
              {people.length ? <div className="portal-people-table"><div className="portal-table-head"><span>Person</span><span>Role</span><span>Assigned area</span>{isManager && <span>Contact</span>}</div>{people.map((person, index) => <div className="portal-table-row" key={`${person.uid}:${person.role}:${index}`}><span className="portal-person"><span className="portal-person-avatar">{(person.displayName || 'U').slice(0, 1).toUpperCase()}</span><strong>{person.displayName}</strong></span><span>{person.roleLabel}</span><span>{person.scopeName || 'Assigned workspace'}</span>{isManager && <span>{person.email || '—'}</span>}</div>)}</div> : <EmptyState title="Your people list is ready">People will appear here as administrators assign roles within this scope.</EmptyState>}
            </section>}

            {activeTab === 'structure' && <section className="portal-tab-panel">
              <div className="portal-tab-heading"><div><p className="portal-eyebrow">Academic directory</p><h2>Programs and semesters</h2><p>Academic cohorts within your assigned management scope.</p></div></div>
              {sortedPrograms.length ? <div className="portal-program-grid">{sortedPrograms.map((program) => {
                const programSemesters = programSemestersFor(program);
                return <article className="portal-program-card" key={program.id}><div className="portal-program-title"><span>PROGRAM</span><code>{program.code}</code></div><h3>{program.name}</h3><p>Intake {program.intakeYear} · Graduation {program.graduationYear}</p><div className="portal-semester-pills">{programSemesters.slice(0, 8).map((semester) => <span key={semester.id}>{semester.academicYearName} · S{semester.semesterNumber}</span>)}{programSemesters.length > 8 && <small>+{programSemesters.length - 8} more</small>}</div></article>;
              })}</div> : <EmptyState title="No programs in this scope">Program cohorts will appear here when they are registered for your department.</EmptyState>}
            </section>}

            <footer className="portal-footer"><span>MIT ADT LMS <b>·</b> {information.title}</span><span>University workspace · Access follows your assigned role</span></footer>
          </>}
        </div>
      </section>

      {selectedAssessment && <div className="portal-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedAssessment(null); }}><section className="portal-assessment-modal" role="dialog" aria-modal="true" aria-labelledby="assessment-title"><div className="portal-modal-heading"><div><span className={`portal-type-pill type-${selectedAssessment.itemType}`}>{selectedAssessment.itemType}</span><h2 id="assessment-title">{selectedAssessment.title}</h2></div><button type="button" onClick={() => setSelectedAssessment(null)} aria-label="Close assessment">×</button></div><p className="portal-modal-description">{selectedAssessment.description}</p>{selectedAssessment.dueAt && <p className="portal-modal-deadline">Due {formatDate(selectedAssessment.dueAt, true)}</p>}
        <form onSubmit={submitAssessment} className="portal-assessment-form">{selectedAssessment.itemType === 'quiz' ? selectedAssessment.questions.map((question, index) => <fieldset className="portal-question" key={question.id}><legend><strong>{index + 1}. {question.prompt}</strong><span>{question.points} pt{question.points === 1 ? '' : 's'}</span></legend>{question.choices.map((choice, choiceIndex) => <label key={`${question.id}:${choiceIndex}`}><input type="radio" name={question.id} checked={assessmentAnswers[question.id] === choiceIndex} onChange={() => setAssessmentAnswers((current) => ({ ...current, [question.id]: choiceIndex }))} /><span>{choice}</span></label>)}</fieldset>) : <label className="portal-answer-field">Your response<textarea value={assignmentText} onChange={(event) => setAssignmentText(event.target.value)} rows="8" maxLength="10000" placeholder="Write your assignment response here…" required /></label>}<div className="portal-modal-actions"><button type="button" className="portal-secondary-button" onClick={() => setSelectedAssessment(null)}>Cancel</button><button className="portal-primary-button" disabled={saving === `submit:${selectedAssessment.id}`}>{saving === `submit:${selectedAssessment.id}` ? 'Submitting…' : 'Submit work'}</button></div></form></section></div>}
    </main>
  );
}

function ContentComposer({ offerings, selectedOfferingId, setSelectedOfferingId, itemType, setItemType, title, setTitle, description, setDescription, resourceUrl, setResourceUrl, dueAt, setDueAt, maxPoints, setMaxPoints, publishNow, setPublishNow, questions, setQuestions, updateQuestion, updateChoice, saving, onSubmit, onCancel, capabilities, editing }) {
  const contentTypes = editing ? [[itemType, itemType.charAt(0).toUpperCase() + itemType.slice(1)]] : capabilities.createCourseContent
    ? [['quiz', 'Quiz'], ['assignment', 'Assignment'], ['resource', 'Resource'], ['announcement', 'Announcement']]
    : [['announcement', 'Announcement']];
  return <form className="portal-composer" onSubmit={onSubmit}>
    <div className="portal-composer-heading"><div><p className="portal-eyebrow">Course authoring</p><h3>{editing ? 'Edit draft' : `Create ${itemType}`}</h3><p>Students see published items in their assigned teaching group.</p></div><button type="button" className="portal-composer-close" onClick={onCancel} aria-label="Close form">×</button></div>
    <div className="portal-composer-grid">
      <label>Teaching group<select value={selectedOfferingId} onChange={(event) => setSelectedOfferingId(event.target.value)} required><option value="">Choose a teaching group</option>{offerings.map((offering) => <option value={offering.id} key={offering.id}>{offering.subjectName} · {offering.divisionName} · {offering.academicYearName}</option>)}</select></label>
      <label>Content type<select value={itemType} onChange={(event) => setItemType(event.target.value)} disabled={editing}>{contentTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="portal-composer-wide">Title<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength="120" required placeholder={itemType === 'quiz' ? 'e.g. Unit 1 knowledge check' : itemType === 'assignment' ? 'e.g. Data modelling exercise' : itemType === 'resource' ? 'e.g. Week 2 reading list' : 'e.g. Class schedule update'} /></label>
      <label className="portal-composer-wide">{itemType === 'announcement' ? 'Message' : itemType === 'resource' ? 'Description' : 'Instructions'}<textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength="5000" rows="3" required placeholder="Write clear details for your class…" /></label>
      {itemType === 'resource' && <label className="portal-composer-wide">HTTPS resource link<input type="url" value={resourceUrl} onChange={(event) => setResourceUrl(event.target.value)} required placeholder="https://…" /></label>}
      {(itemType === 'quiz' || itemType === 'assignment') && <label>Due date and time<input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} /></label>}
      {itemType === 'assignment' && <label>Maximum points<input type="number" min="1" max="1000" value={maxPoints} onChange={(event) => setMaxPoints(event.target.value)} required /></label>}
    </div>
    {itemType === 'quiz' && <div className="portal-question-builder"><div className="portal-section-heading"><div><p className="portal-eyebrow">Question builder</p><h3>Questions</h3></div><button type="button" className="portal-secondary-button compact" disabled={questions.length >= 30} onClick={() => setQuestions((current) => [...current, { prompt: '', choices: ['', '', '', ''], answerIndex: 0, points: 1 }])}>＋ Add question</button></div>
      {questions.map((question, index) => <fieldset className="portal-builder-question" key={`builder-${index}`}><div className="portal-builder-question-heading"><strong>Question {index + 1}</strong><label>Points<input type="number" min="1" max="100" value={question.points} onChange={(event) => updateQuestion(index, 'points', event.target.value)} required /></label>{questions.length > 1 && <button type="button" onClick={() => setQuestions((current) => current.filter((_, questionIndex) => questionIndex !== index))}>Remove</button>}</div><label>Question prompt<input value={question.prompt} maxLength="500" onChange={(event) => updateQuestion(index, 'prompt', event.target.value)} required placeholder="Write a clear question" /></label><div className="portal-choice-grid">{question.choices.map((choice, choiceIndex) => <label key={choiceIndex}><span><input type="radio" name={`correct-${index}`} checked={Number(question.answerIndex) === choiceIndex} onChange={() => updateQuestion(index, 'answerIndex', choiceIndex)} /> Correct answer</span><input value={choice} maxLength="240" onChange={(event) => updateChoice(index, choiceIndex, event.target.value)} required placeholder={`Option ${String.fromCharCode(65 + choiceIndex)}`} /></label>)}</div></fieldset>)}
    </div>}
    <div className="portal-composer-footer"><label className="portal-publish-choice"><input type="checkbox" checked={publishNow} onChange={(event) => setPublishNow(event.target.checked)} /> Publish immediately</label><div><button className="portal-secondary-button" type="button" onClick={onCancel}>Cancel</button><button className="portal-primary-button" disabled={saving === 'content' || !offerings.length}>{saving === 'content' ? 'Saving…' : publishNow ? 'Publish' : 'Save draft'}</button></div></div>
  </form>;
}
