import type { ReactNode } from 'react';

/** The frame of every signed-out screen: sign-in, forgot password and reset password (#191). */
export function AuthShell({
  title,
  lead,
  children,
  footer,
  actions,
}: {
  title: string;
  lead?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** Top-right controls, e.g. the theme menu on the sign-in page. */
  actions?: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-bg">
      <div className="flex min-h-[56px] justify-end p-3">{actions}</div>
      <main className="flex flex-1 items-start justify-center px-4 pt-[8vh] pb-16">
        <div className="w-full max-w-[380px]">
          <div className="mb-6 flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-md bg-fg text-[13px] font-semibold text-bg" aria-hidden>
              A
            </span>
            <span className="text-[15px] font-semibold">Agentic Marketing</span>
          </div>
          <h1 className="text-[20px] leading-7 font-semibold">{title}</h1>
          {lead && <p className="mt-1 text-[13px] text-muted">{lead}</p>}
          <div className="mt-6">{children}</div>
          {footer && <div className="mt-8 border-t border-line pt-5 text-[13px] text-muted">{footer}</div>}
        </div>
      </main>
    </div>
  );
}
