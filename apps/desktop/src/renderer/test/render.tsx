import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import type { AppHubApi } from '../../../shared/ipc';
import { ApiProvider } from '../src/components/ApiProvider';
import { ProgressProvider } from '../src/components/Progress';
import { ToastProvider } from '../src/components/Toast';
import { UpdateProvider } from '../src/components/UpdateProvider';

/** 渲染单个视图/组件，注入 mock api 与全局 Toast/Progress/Update 上下文。 */
export function renderWithApi(ui: ReactElement, api: AppHubApi) {
  return render(
    <ApiProvider api={api}>
      <ToastProvider>
        <ProgressProvider>
          <UpdateProvider>{ui}</UpdateProvider>
        </ProgressProvider>
      </ToastProvider>
    </ApiProvider>,
  );
}

export { screen, waitFor, within, act, render } from '@testing-library/react';
export { default as userEvent } from '@testing-library/user-event';
