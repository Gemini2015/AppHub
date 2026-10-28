import { useEffect, useMemo, useState } from 'react';
import { useApi } from '../api';
import { CheckboxField, InfoBanner, ApiErrorBanner, SelectField, TextAreaField, TextField } from '../components/Form';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { ProgressBar } from '../components/Progress';
import { useToast } from '../components/Toast';
import {
  errorTitle,
  formatBytes,
  formatDateTime,
  isValidSemver,
  platformLabel,
  progressPercent,
} from '../format';
import type {
  ApiError,
  AppDetailDTO,
  InspectSelectionResultDTO,
  Platform,
  ProgressEventDTO,
  PublishMode,
  PublishRequestDTO,
  PublishResultDTO,
  PublishSelectionDTO,
  PickKind,
} from '../types';

export interface PublishWizardProps {
  channelId: string;
  channelName?: string;
  /** 已有 App（发布新版本）时传入；null 表示发布新 App。 */
  app: AppDetailDTO | null;
  onClose: () => void;
  onPublished: (result: PublishResultDTO) => void;
}

type FieldErrors = Partial<
  Record<'displayName' | 'appId' | 'version' | 'homepage' | 'description' | 'author' | 'changelog' | 'selection' | 'entry' | 'overwrite', string>
>;

const PLATFORM_OPTIONS = [
  { value: 'windows', label: 'Windows' },
  { value: 'linux', label: 'Linux' },
  { value: 'mac', label: 'macOS' },
];

const APP_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?$/;

const KIND_LABEL: Record<PickKind, string> = {
  files: '散文件',
  folder: '文件夹',
  zip: '压缩包',
};

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

const STEPS = [
  { key: 1, title: '基本信息', hint: 'App 与版本' },
  { key: 2, title: '选择文件', hint: '文件与入口' },
  { key: 3, title: '确认发布', hint: '上传并写入元信息' },
] as const;

/** 发布 App / 新版本向导：信息 → 文件（files/zip）→ 确认 → 进度/结果。 */
export function PublishWizard({ channelId, channelName, app, onClose, onPublished }: PublishWizardProps) {
  const api = useApi();
  const toast = useToast();
  const isExisting = app !== null;
  const existingVersions = app?.versions ?? [];

  const [step, setStep] = useState(1);
  const [displayName, setDisplayName] = useState(app?.meta.displayName ?? '');
  const [appIdInput, setAppIdInput] = useState('');
  const [description, setDescription] = useState(app?.meta.description ?? '');
  const [author, setAuthor] = useState(app?.meta.author ?? '');
  const [homepage, setHomepage] = useState(app?.meta.homepage ?? '');
  const [publishMode, setPublishMode] = useState<PublishMode>(app?.meta.publishMode ?? 'files');
  const [platform, setPlatform] = useState<Platform>(app?.meta.platforms[0] ?? 'windows');
  const [version, setVersion] = useState('');
  const [changelog, setChangelog] = useState('');

  const [selection, setSelection] = useState<PublishSelectionDTO | null>(null);
  const [inspect, setInspect] = useState<InspectSelectionResultDTO | null>(null);
  const [entry, setEntry] = useState('');
  const [entryManual, setEntryManual] = useState(false);
  const [picking, setPicking] = useState<PickKind | null>(null);

  const [overwriteConfirmed, setOverwriteConfirmed] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [progress, setProgress] = useState<ProgressEventDTO | null>(null);
  const [success, setSuccess] = useState<PublishResultDTO | null>(null);

  // 发布期间订阅主进程进度事件（只关心 publish 操作）。
  useEffect(() => {
    const unsubscribe = api.events.onProgress((event) => {
      if (event.operation === 'publish') setProgress(event);
    });
    return unsubscribe;
  }, [api]);

  const trimmedVersion = version.trim();
  const versionExists =
    isExisting && trimmedVersion.length > 0 && existingVersions.some((item) => item.version === trimmedVersion);
  const canPublishModeChange = !isExisting;

  const entryOptions = useMemo(() => inspect?.files.map((file) => file.path) ?? [], [inspect]);

  /** 用户修改字段时立即清掉该字段上一次的校验错误。 */
  const clearError = (field: keyof FieldErrors): void => {
    setErrors((current) => (current[field] ? { ...current, [field]: undefined } : current));
  };

  const inspectedFileCount = inspect ? inspect.files.length : selection?.files.length ?? 0;
  const inspectedTotalSize = inspect
    ? inspect.files.reduce((sum, file) => sum + file.size, 0)
    : selection?.files.reduce((sum, file) => sum + file.size, 0) ?? 0;

  const validateStep1 = (): FieldErrors => {
    const next: FieldErrors = {};
    if (!displayName.trim()) next.displayName = '请输入 App 名称';
    else if (displayName.trim().length > 128) next.displayName = 'App 名称不能超过 128 个字符';
    if (!isExisting && appIdInput.trim() && !APP_ID_PATTERN.test(appIdInput.trim())) {
      next.appId = 'App 标识只能包含小写字母、数字、. _ -，且首尾必须是字母或数字';
    }
    if (description.length > 4096) next.description = '简介不能超过 4096 个字符';
    if (author.length > 256) next.author = '作者不能超过 256 个字符';
    if (homepage.trim() && !isHttpUrl(homepage.trim())) next.homepage = '主页必须是 http(s) 地址';
    if (!trimmedVersion) next.version = '请输入版本号';
    else if (!isValidSemver(trimmedVersion)) next.version = '版本号必须符合 semver，例如 1.0.0 或 1.2.3-beta.1';
    if (changelog.length > 10000) next.changelog = '更新说明不能超过 10000 个字符';
    return next;
  };

  const validateStep2 = (): FieldErrors => {
    const next: FieldErrors = {};
    if (!selection) {
      next.selection = '请先选择要发布的文件或压缩包';
      return next;
    }
    if (!entry.trim()) {
      next.entry = '请选择或输入启动入口';
      return next;
    }
    if (inspect && inspect.files.length > 0 && !inspect.files.some((file) => file.path === entry.trim())) {
      next.entry = '启动入口必须属于已选择的文件';
    }
    return next;
  };

  const goNext = () => {
    const nextErrors = step === 1 ? validateStep1() : validateStep2();
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setFailure(null);
    setStep((current) => Math.min(3, current + 1));
  };

  const goBack = () => {
    setErrors({});
    setFailure(null);
    setStep((current) => Math.max(1, current - 1));
  };

  const pick = async (kind: PickKind) => {
    setPicking(kind);
    setFailure(null);
    setErrors((current) => ({ ...current, selection: undefined, entry: undefined }));
    try {
      const result = await api.publish.pick(kind);
      if (!result.ok) {
        setFailure(result.error);
        toast.error(result.error, '选择文件失败');
        return;
      }
      if (!result.value) return; // 用户取消
      setSelection(result.value);
      setInspect(null);
      setEntry('');
      setEntryManual(false);
      const inspected = await api.publish.inspectSelection(result.value.selectionId);
      if (!inspected.ok) {
        setFailure(inspected.error);
        toast.error(inspected.error, '读取所选文件失败');
        return;
      }
      setInspect(inspected.value);
      const suggested = inspected.value.suggestedEntry;
      if (suggested && inspected.value.files.some((file) => file.path === suggested)) setEntry(suggested);
      else if (inspected.value.files[0]) setEntry(inspected.value.files[0].path);
    } finally {
      setPicking(null);
    }
  };

  const buildRequest = (): PublishRequestDTO => {
    const request: PublishRequestDTO = {
      channelId,
      displayName: displayName.trim(),
      version: trimmedVersion,
      platform,
      publishMode,
      entry: entry.trim(),
      selectionId: selection?.selectionId ?? '',
    };
    if (isExisting && app) request.appId = app.meta.appId;
    else if (!isExisting && appIdInput.trim()) request.appId = appIdInput.trim();
    if (description.trim()) request.description = description.trim();
    if (author.trim()) request.author = author.trim();
    if (homepage.trim()) request.homepage = homepage.trim();
    if (changelog.trim()) request.changelog = changelog.trim();
    if (versionExists) request.overwrite = true;
    return request;
  };

  const publish = async () => {
    const nextErrors: FieldErrors = { ...validateStep1(), ...validateStep2() };
    if (versionExists && !overwriteConfirmed) nextErrors.overwrite = '请勾选确认覆盖已存在的版本';
    setErrors(nextErrors);
    if (nextErrors.version || nextErrors.displayName || nextErrors.appId || nextErrors.homepage) {
      setStep(1);
      return;
    }
    if (nextErrors.selection || nextErrors.entry) {
      setStep(2);
      return;
    }
    if (nextErrors.overwrite) return;
    if (!selection) return;

    setPublishing(true);
    setFailure(null);
    setProgress(null);
    try {
      const result = await api.publish.start(buildRequest());
      if (!result.ok) {
        setFailure(result.error);
        toast.error(result.error, '发布失败');
        return;
      }
      setSuccess(result.value);
      toast.success(`已发布 ${result.value.appId} v${result.value.version}`);
      onPublished(result.value);
    } catch {
      const error: ApiError = { code: 'INTERNAL', message: '发布时发生未知错误，请查看主进程日志。' };
      setFailure(error);
      toast.error(error, '发布失败');
    } finally {
      setPublishing(false);
    }
  };

  // -------------------------------------------------------------------------
  // 成功结果页
  // -------------------------------------------------------------------------
  if (success) {
    return (
      <Modal
        title={isExisting ? '发布新版本' : '发布 App'}
        subtitle={channelName ? `频道：${channelName}` : undefined}
        testId="publish-wizard"
        size="md"
        onClose={onClose}
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                const text = success.metaUrl;
                void navigator.clipboard?.writeText(text).then(
                  () => toast.success('meta URL 已复制'),
                  () => toast.info(text),
                );
              }}
            >
              <Icon name="copy" size={16} />
              复制 meta URL
            </button>
            <div className="footer-spacer" />
            <button type="button" className="btn btn-primary" onClick={onClose}>
              完成
            </button>
          </>
        }
      >
        <div className="result-view">
          <span className="result-icon result-icon-success">
            <Icon name="check-circle" size={34} />
          </span>
          <h3>发布成功</h3>
          <p className="muted">
            {success.appId} v{success.version}（{platformLabel(success.platform)}）
          </p>
          <dl className="summary-list">
            <div>
              <dt>发布方式</dt>
              <dd>{success.publishMode === 'zip' ? '压缩包' : '散文件'}</dd>
            </div>
            <div>
              <dt>文件数量</dt>
              <dd>{success.fileCount} 个</dd>
            </div>
            <div>
              <dt>总大小</dt>
              <dd>{formatBytes(success.totalSize)}</dd>
            </div>
            <div>
              <dt>meta URL</dt>
              <dd className="mono break-all">{success.metaUrl}</dd>
            </div>
            <div>
              <dt>频道更新时间</dt>
              <dd>{formatDateTime(success.channelUpdatedAt)}</dd>
            </div>
          </dl>
          <InfoBanner tone="success" title="订阅者现在可以在频道里看到这个版本">
            元信息已按 <code>payload → files.json → app.meta.json → channel.json</code> 的顺序写入。
          </InfoBanner>
        </div>
      </Modal>
    );
  }

  const footer = (
    <>
      <button type="button" className="btn btn-ghost" onClick={onClose} disabled={publishing}>
        取消
      </button>
      <div className="footer-spacer" />
      {step > 1 ? (
        <button type="button" className="btn btn-secondary" onClick={goBack} disabled={publishing}>
          上一步
        </button>
      ) : null}
      {step < 3 ? (
        <button type="button" className="btn btn-primary" data-testid="publish-next" onClick={goNext} disabled={publishing}>
          下一步
          <Icon name="chevron-right" size={16} />
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-primary"
          data-testid="publish-submit"
          onClick={() => void publish()}
          disabled={publishing}
        >
          {publishing ? '正在发布…' : '发布'}
        </button>
      )}
    </>
  );

  return (
    <Modal
      title={isExisting ? '发布新版本' : '发布 App'}
      subtitle={channelName ? `频道：${channelName}` : undefined}
      testId="publish-wizard"
      size="lg"
      closable={!publishing}
      onClose={onClose}
      footer={footer}
      headerExtra={
        <ol className="steps">
          {STEPS.map((item) => (
            <li
              key={item.key}
              className={
                step === item.key ? 'step step-active' : step > item.key ? 'step step-done' : 'step'
              }
            >
              <span className="step-index">{step > item.key ? <Icon name="check" size={13} /> : item.key}</span>
              <span className="step-text">
                <strong>{item.title}</strong>
                <small>{item.hint}</small>
              </span>
            </li>
          ))}
        </ol>
      }
    >
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          if (publishing) return;
          if (step < 3) goNext();
          else void publish();
        }}
      >
        {failure ? (
          <div data-testid="dialog-error">
            <ApiErrorBanner error={failure} title={errorTitle(failure)} />
          </div>
        ) : null}

        {step === 1 ? (
          <div className="form-section">
            <div className="grid grid-2">
              {isExisting ? (
                <TextField
                  label="App 标识"
                  value={app?.meta.appId ?? ''}
                  onChange={() => undefined}
                  disabled
                  mono
                  hint="已有 App 的标识不可修改。"
                />
              ) : (
                <TextField
                  label="App 标识（可选）"
                  value={appIdInput}
                  onChange={setAppIdInput}
                  placeholder="例如 foobar（留空自动生成）"
                  hint="同时作为存储目录名：小写字母/数字，可含 . _ -。"
                  error={errors.appId}
                  disabled={publishing}
                  mono
                />
              )}
              <TextField
                label="App 名称（displayName）"
                testId="publish-display-name"
                value={displayName}
                onChange={(value) => {
                  setDisplayName(value);
                  clearError('displayName');
                }}
                required
                maxLength={128}
                placeholder="例如：FooBar"
                error={errors.displayName}
                disabled={publishing}
              />
            </div>

            <TextAreaField
              label="简介"
              value={description}
              onChange={setDescription}
              rows={2}
              maxLength={4096}
              placeholder="一句话介绍这个 App"
              error={errors.description}
              disabled={publishing}
            />

            <div className="grid grid-2">
              <TextField
                label="作者"
                value={author}
                onChange={setAuthor}
                maxLength={256}
                placeholder="例如：Alice"
                error={errors.author}
                disabled={publishing}
              />
              <TextField
                label="主页（可选）"
                value={homepage}
                onChange={setHomepage}
                type="url"
                placeholder="https://example.com/foobar"
                error={errors.homepage}
                disabled={publishing}
                mono
              />
            </div>

            <div className="form-section provider-panel">
              <div className="field">
                <span className="field-label">发布方式</span>
                {canPublishModeChange ? (
                  <div className="segmented" role="group" aria-label="发布方式">
                    <button
                      type="button"
                      className={publishMode === 'files' ? 'segment segment-active' : 'segment'}
                      aria-pressed={publishMode === 'files'}
                      onClick={() => setPublishMode('files')}
                      disabled={publishing}
                    >
                      <Icon name="file" size={16} />
                      散文件
                    </button>
                    <button
                      type="button"
                      className={publishMode === 'zip' ? 'segment segment-active' : 'segment'}
                      aria-pressed={publishMode === 'zip'}
                      onClick={() => setPublishMode('zip')}
                      disabled={publishing}
                    >
                      <Icon name="box" size={16} />
                      压缩包（zip）
                    </button>
                  </div>
                ) : (
                  <div className="readonly-row">
                    <Icon name={app?.meta.publishMode === 'zip' ? 'box' : 'file'} size={16} />
                    {app?.meta.publishMode === 'zip' ? '压缩包（zip）' : '散文件（files）'}
                    <span className="muted">（发布方式创建后不可更改）</span>
                  </div>
                )}
                <p className="field-hint">
                  {publishMode === 'files'
                    ? '散文件模式：每个文件单独上传，更新时按 MD5 复用未变化文件；适合文件数不多、频繁小改的 App。'
                    : '压缩包模式：把整个目录打成 zip 上传，安装时下载并解压；适合文件多、结构固定的 App。'}
                </p>
              </div>

              <div className="grid grid-2">
                <SelectField
                  label="平台"
                  value={platform}
                  onChange={(value) => setPlatform(value as Platform)}
                  options={PLATFORM_OPTIONS}
                  required
                  hint="版本目录在频道内全局唯一，不同平台请使用不同版本号，或为各平台分别建 App。"
                  disabled={publishing}
                />
                <TextField
                  label="版本号（semver）"
                  testId="publish-version"
                  value={version}
                  onChange={(value) => {
                    setVersion(value);
                    clearError('version');
                  }}
                  required
                  placeholder="例如 1.0.1"
                  hint={
                    versionExists
                      ? '⚠️ 该版本已存在，提交时需要确认覆盖。'
                      : '必须符合 semver；建议递增且大于当前平台 latest。'
                  }
                  error={errors.version}
                  disabled={publishing}
                  mono
                />
              </div>
              {versionExists ? (
                <InfoBanner tone="warn" title="版本已存在">
                  版本 <code>{trimmedVersion}</code> 已存在于该 App 的历史版本中。继续发布会覆盖该版本（overwrite），
                  历史记录将被替换。
                </InfoBanner>
              ) : null}
            </div>

            <TextAreaField
              label="更新说明（changelog）"
              value={changelog}
              onChange={setChangelog}
              rows={3}
              maxLength={10000}
              placeholder="这个版本有哪些变化？"
              error={errors.changelog}
              disabled={publishing}
            />
          </div>
        ) : null}

        {step === 2 ? (
          <div className="form-section">
            <div className="field">
              <span className="field-label">
                选择要发布的内容
                <span className="field-req" aria-hidden="true">
                  {' '}
                  *
                </span>
              </span>
              <div className="pick-actions">
                {publishMode === 'files' ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => void pick('files')}
                      disabled={picking !== null || publishing}
                    >
                      <Icon name="file" size={16} />
                      {picking === 'files' ? '选择中…' : '选择文件'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => void pick('folder')}
                      disabled={picking !== null || publishing}
                    >
                      <Icon name="folder" size={16} />
                      {picking === 'folder' ? '选择中…' : '选择文件夹'}
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => void pick('zip')}
                      disabled={picking !== null || publishing}
                    >
                      <Icon name="box" size={16} />
                      {picking === 'zip' ? '选择中…' : '选择压缩包（zip）'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => void pick('folder')}
                      disabled={picking !== null || publishing}
                    >
                      <Icon name="folder" size={16} />
                      {picking === 'folder' ? '选择中…' : '选择文件夹并自动打包'}
                    </button>
                  </>
                )}
              </div>
              <p className="field-hint">
                {publishMode === 'files'
                  ? '选择散文件或文件夹（保留相对目录结构）。'
                  : '选择 zip 压缩包，或选择文件夹由 AppHub 自动打包。'}
              </p>
              {errors.selection ? (
                <p className="field-error" role="alert">
                  {errors.selection}
                </p>
              ) : null}
            </div>

            {selection ? (
              <div className="selection-card card">
                <div className="selection-head">
                  <span className="badge badge-info">{KIND_LABEL[selection.kind]}</span>
                  <strong>{inspectedFileCount} 个文件</strong>
                  <span className="muted">共 {formatBytes(inspectedTotalSize)}</span>
                  {inspect?.zip ? (
                    <span className="muted">
                      · 压缩包 {inspect.zip.name}（{formatBytes(inspect.zip.size)}）
                    </span>
                  ) : null}
                </div>
                {inspect && inspect.files.length > 0 ? (
                  <ul className="file-list">
                    {inspect.files.slice(0, 100).map((file) => (
                      <li key={file.path}>
                        <Icon name="file" size={13} />
                        <code className="file-path">{file.path}</code>
                        <span className="muted">{formatBytes(file.size)}</span>
                        {file.path === entry ? <span className="badge badge-success">入口</span> : null}
                      </li>
                    ))}
                    {inspect.files.length > 100 ? (
                      <li className="muted">…等共 {inspect.files.length} 个文件</li>
                    ) : null}
                  </ul>
                ) : (
                  <p className="muted">正在读取所选文件列表…</p>
                )}
              </div>
            ) : (
              <InfoBanner tone="info" title="还没有选择文件">
                点击上方按钮选择散文件 / 文件夹 / zip 压缩包。文件路径不会进入渲染进程，主进程只返回 selection 令牌。
              </InfoBanner>
            )}

            <div className="field">
              <span className="field-label">
                启动入口
                <span className="field-req" aria-hidden="true">
                  {' '}
                  *
                </span>
              </span>
              {entryOptions.length > 0 && !entryManual ? (
                <SelectField
                  label="启动入口（从已选文件中选择）"
                  testId="publish-entry"
                  value={entry}
                  onChange={setEntry}
                  options={[
                    ...entryOptions.map((path) => ({ value: path, label: path })),
                    ...(entry && !entryOptions.includes(entry) ? [{ value: entry, label: entry }] : []),
                  ]}
                  required
                  error={errors.entry}
                  disabled={publishing}
                />
              ) : (
                <TextField
                  label="启动入口（手动输入相对路径）"
                  testId="publish-entry"
                  value={entry}
                  onChange={setEntry}
                  required
                  placeholder="例如 foobar.exe 或 bin/foobar"
                  hint="相对于发布根目录的路径，必须属于本次发布的文件。"
                  error={errors.entry}
                  disabled={publishing}
                  mono
                />
              )}
              {entryOptions.length > 0 ? (
                <button type="button" className="link-btn" onClick={() => setEntryManual((current) => !current)}>
                  {entryManual ? '← 从已选文件中选择' : '手动输入入口路径'}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {step === 3 ? (
          <div className="form-section">
            {publishing || progress ? (
              <ProgressBar
                percent={progressPercent(progress)}
                label={`正在发布 v${trimmedVersion}`}
                detail={progress ? `${progress.phase}${progress.message ? ` · ${progress.message}` : ''}` : '准备中…'}
                currentFile={progress?.currentFile}
                index={progress?.index}
                count={progress?.count}
              />
            ) : null}

            <div className="summary card summary-card">
              <h3>确认发布内容</h3>
              <dl className="summary-list">
                <div>
                  <dt>频道</dt>
                  <dd>{channelName ?? channelId}</dd>
                </div>
                <div>
                  <dt>App</dt>
                  <dd>
                    {displayName.trim() || '—'}
                    <span className="muted"> · {isExisting ? app?.meta.appId : appIdInput.trim() || '自动生成'}</span>
                  </dd>
                </div>
                <div>
                  <dt>版本 / 平台</dt>
                  <dd>
                    v{trimmedVersion || '—'} · {platformLabel(platform)}
                  </dd>
                </div>
                <div>
                  <dt>发布方式</dt>
                  <dd>{publishMode === 'zip' ? '压缩包（zip）' : '散文件（files）'}</dd>
                </div>
                <div>
                  <dt>启动入口</dt>
                  <dd className="mono">{entry || '—'}</dd>
                </div>
                <div>
                  <dt>文件</dt>
                  <dd>
                    {inspectedFileCount} 个 · {formatBytes(inspectedTotalSize)}
                  </dd>
                </div>
                <div>
                  <dt>更新说明</dt>
                  <dd>{changelog.trim() || '—'}</dd>
                </div>
              </dl>
            </div>

            {versionExists ? (
              <>
                <InfoBanner tone="warn" title="覆盖风险">
                  <code>{trimmedVersion}</code> 已存在于该 App，发布将覆盖该版本的文件与历史记录，且不可撤销。
                </InfoBanner>
                <CheckboxField
                  label="我确认覆盖已存在的版本（overwrite）"
                  checked={overwriteConfirmed}
                  onChange={setOverwriteConfirmed}
                  error={errors.overwrite}
                  disabled={publishing}
                />
              </>
            ) : null}

            {failure ? (
              <InfoBanner tone="error" title="发布失败">
                {failure.message}
                <code className="error-code">{failure.code}</code>
              </InfoBanner>
            ) : null}

            <p className="field-hint">
              写入顺序：payload → files.json → app.meta.json → channel.json；任何一步失败都不会留下指向缺失文件的元信息。
            </p>
          </div>
        ) : null}
      </form>
    </Modal>
  );
}
