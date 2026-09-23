import { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

export interface ErrorBoundaryProps {
  children: ReactNode;
  fallbackTitle?: string;
  onReset?: () => void;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
  retryCount: number;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  public override state: State = {
    hasError: false,
    error: null,
    retryCount: 0,
  };

  public static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  public override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[ErrorBoundary caught error]', error, errorInfo);
    if (this.props.onError) {
      this.props.onError(error, errorInfo);
    }
  }

  private handleReset = () => {
    this.setState((prev) => ({
      hasError: false,
      error: null,
      retryCount: prev.retryCount + 1,
    }));
    if (this.props.onReset) {
      this.props.onReset();
    }
  };

  private handleReload = () => {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  public override render() {
    if (this.state.hasError) {
      const isMaxRetriesReached = this.state.retryCount >= 3;

      return (
        <div
          role="alert"
          aria-live="assertive"
          className="flex flex-col items-center justify-center p-6 bg-red-950/40 border border-red-500/30 rounded-xl text-center backdrop-blur-md m-4"
        >
          <div className="w-12 h-12 rounded-full bg-red-500/20 text-red-400 flex items-center justify-center mb-3">
            <AlertTriangle className="w-6 h-6" />
          </div>
          <h2 className="text-lg font-semibold text-white mb-1">
            {this.props.fallbackTitle || 'Something went wrong rendering this view'}
          </h2>
          <p
            tabIndex={0}
            className="text-red-200/80 mb-4 max-w-md font-mono text-xs overflow-auto max-h-24 p-2 bg-black/40 rounded border border-red-500/20"
          >
            {this.state.error?.message || 'An unexpected rendering error occurred'}
          </p>
          {isMaxRetriesReached ? (
            <button
              onClick={this.handleReload}
              className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-500 active:scale-95 transition-all text-white font-medium text-sm rounded-lg shadow-lg shadow-red-900/30 cursor-pointer"
            >
              <RefreshCw className="w-4 h-4" />
              Reload Page
            </button>
          ) : (
            <button
              onClick={this.handleReset}
              className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-500 active:scale-95 transition-all text-white font-medium text-sm rounded-lg shadow-lg shadow-red-900/30 cursor-pointer"
            >
              <RefreshCw className="w-4 h-4" />
              Try Again ({3 - this.state.retryCount} attempts remaining)
            </button>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
