import React from 'react';

/**
 * A canvas renders whatever passage a citation points at, so a bad anchor or a
 * malformed file must not be able to unmount the app around it.
 *
 * `resetKey` is the identity of what is being shown: changing it clears the
 * error, so picking another document or another citation tries again.
 */
export class ErrorBoundary extends React.Component<
    { label: string; resetKey: string; children: React.ReactNode },
    { error: Error | null; key: string }
> {
    state = { error: null as Error | null, key: this.props.resetKey };

    static getDerivedStateFromError(error: Error) {
        return { error };
    }

    componentDidUpdate() {
        if (this.props.resetKey !== this.state.key) {
            this.setState({ error: null, key: this.props.resetKey });
        }
    }

    componentDidCatch(error: Error) {
        console.warn('[Viewer] render failed', error);
    }

    render() {
        if (!this.state.error) return this.props.children;
        return (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
                <p className="text-sm font-bold text-slate-700">{this.props.label}</p>
                <p className="max-w-md text-xs text-slate-400">{this.state.error.message}</p>
            </div>
        );
    }
}
