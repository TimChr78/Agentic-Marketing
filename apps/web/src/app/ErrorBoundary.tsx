import { Component, type ReactNode } from 'react';
import { Button, EmptyState, LinkButton } from '../ui';

/**
 * The last line of defence around the route table (#791). A render error in any page used to
 * unmount the whole root and leave a blank admin page; here it becomes a recoverable screen.
 *
 * `resetKey` clears the failure on navigation. It is deliberately not a React `key`: remounting
 * the route subtree would also remount a lazy `Routes` on every navigation, which breaks flows
 * that rely on a route remount finishing a focus return (the approvals drawer).
 */
export class RouteErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { failed: boolean; resetKey?: string }> {
  state = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromProps(props: { resetKey?: string }, state: { failed: boolean; resetKey?: string }) {
    if (props.resetKey === state.resetKey) return null;
    return { failed: false, resetKey: props.resetKey };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <EmptyState
        title="This page could not be shown"
        action={
          <>
            <Button onClick={() => this.setState({ failed: false })}>Try again</Button>
            <LinkButton href="/">Go to Home</LinkButton>
          </>
        }
      >
        Something went wrong while drawing this page. Nothing was saved or sent; try again, or open Home and navigate back.
      </EmptyState>
    );
  }
}
