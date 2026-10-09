import { Component, type ReactNode } from 'react';

/** Part of the app didn't load: most likely Homeoffice was updated and this page's files are gone. */
export class LoadBoundary extends Component<{ what: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error(`${this.props.what} failed to load.`, error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="loading load-failed">
        <div>
          <p>{this.props.what} didn’t load. Homeoffice may have just been updated.</p>
          <button className="btn primary" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
