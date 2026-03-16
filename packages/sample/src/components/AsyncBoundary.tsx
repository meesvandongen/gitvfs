import { Component, Suspense, type ReactNode } from 'react'

interface AsyncBoundaryProps {
  children: ReactNode
  fallback: ReactNode
  resetKey?: string
  errorTitle?: string
}

interface AsyncBoundaryState {
  error: Error | null
}

class AsyncErrorBoundary extends Component<AsyncBoundaryProps, AsyncBoundaryState> {
  override state: AsyncBoundaryState = {
    error: null,
  }

  static getDerivedStateFromError(error: Error): AsyncBoundaryState {
    return { error }
  }

  override componentDidUpdate(prevProps: AsyncBoundaryProps): void {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error !== null) {
      this.setState({ error: null })
    }
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div className="callout callout-danger">
          <strong>{this.props.errorTitle ?? 'Something went wrong.'}</strong>
          <div>{this.state.error.message}</div>
        </div>
      )
    }

    return this.props.children
  }
}

export function AsyncBoundary(props: AsyncBoundaryProps) {
  return (
    <AsyncErrorBoundary {...props}>
      <Suspense fallback={props.fallback}>{props.children}</Suspense>
    </AsyncErrorBoundary>
  )
}