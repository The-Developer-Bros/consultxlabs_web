# Stream SDK Error Handling

Comprehensive guide to error detection, handling, and recovery in Stream Chat and Video integration.

## Navigation

- [Back to README](./README.md)
- [Architecture](./01-architecture.md)
- [Setup & Configuration](./02-setup-configuration.md)
- [Provider & Authentication](./03-provider-authentication.md)
- [Hooks & Utilities](./11-hooks-utilities.md)
- [Troubleshooting](./troubleshooting.md)
- [Recording & Webhooks](./13-recording-webhooks.md)

---

## Table of Contents

1. [Error Handling Architecture](#error-handling-architecture)
2. [StreamErrorBoundary Component](#streamerrorboundary-component)
3. [Connection Retry Logic](#connection-retry-logic)
4. [Error Categories](#error-categories)
5. [Error Recovery Patterns](#error-recovery-patterns)
6. [Implementation Examples](#implementation-examples)

---

## Error Handling Architecture

The Stream integration uses a multi-layered error handling approach:

```
┌─────────────────────────────────────┐
│   StreamErrorBoundary (React)       │  ← Catches render errors
├─────────────────────────────────────┤
│   StreamProvider (Connection)       │  ← Handles connection errors
├─────────────────────────────────────┤
│   Custom Hooks (useGetCallById)    │  ← Handles operation errors
├─────────────────────────────────────┤
│   Stream SDK (Native)               │  ← SDK-level errors
└─────────────────────────────────────┘
```

### Key Principles

1. **Fail Gracefully**: Never crash the entire app
2. **Retry Smartly**: Exponential backoff with max attempts
3. **Inform Users**: Clear, actionable error messages
4. **Log Everything**: Comprehensive error tracking for debugging
5. **Recover Automatically**: When safe and possible

---

## Server-Side Circuit Breaker (#473)

The error boundary and retry mechanisms below protect the browser. As of #473, the server-side hot paths that call Stream are additionally wrapped in the shared circuit breaker (`withCircuitBreaker`, the same primitive already used for Redis) through `withStreamCircuitBreaker` in `lib/stream-client.ts`. Without it, a Stream outage made every authenticated dashboard load wait out the full thirty-second client timeout on each Stream call and cascade, because chat and video are touched on nearly every load. With the breaker, once Stream has failed enough times the breaker opens and subsequent calls fail in under a millisecond instead of hanging.

Closed-breaker behaviour is identical to calling Stream directly, so a genuine Stream error still propagates unchanged. Only when the breaker is already open does a wrapped call short-circuit: a caller that supplied a fallback degrades gracefully — the channel queries return an empty list so the dashboard still renders — while a caller without one receives a typed `StreamUnavailableError` so it can branch on "Stream is down" rather than misread the outage as "no data". The wrapped hot paths today are the channel queries, the channel membership upserts, and the user connect and upsert calls.

---

## StreamErrorBoundary Component

React Error Boundary specifically designed for Stream services.

### Location

```
/components/stream/StreamErrorBoundary.tsx
```

### Features

- Automatic error detection and categorization
- Retry mechanism with max 3 attempts
- Development mode debugging tools
- Custom fallback component support
- Error type classification (chat, video, general)

### Basic Usage

```typescript
import StreamErrorBoundary from '@/components/stream/StreamErrorBoundary';

function App() {
  return (
    <StreamErrorBoundary enableRetry={true}>
      <StreamProvider userId={userId}>
        <ChatInterface />
      </StreamProvider>
    </StreamErrorBoundary>
  );
}
```

### Props Interface

```typescript
interface StreamErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ComponentType<StreamErrorBoundaryState>;
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
  enableRetry?: boolean;
}

interface StreamErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
  errorType: "chat" | "video" | "general";
}
```

### Error Detection

The boundary automatically categorizes errors:

```typescript
static getDerivedStateFromError(error: Error) {
  let errorType: "chat" | "video" | "general" = "general";

  const errorString = error.toString().toLowerCase();

  if (
    errorString.includes("chat") ||
    errorString.includes("message") ||
    errorString.includes("channel")
  ) {
    errorType = "chat";
  } else if (
    errorString.includes("video") ||
    errorString.includes("call") ||
    errorString.includes("stream")
  ) {
    errorType = "video";
  }

  return { hasError: true, error, errorType };
}
```

### Retry Mechanism

Maximum 3 retry attempts with manual trigger:

```typescript
private retryCount = 0;
private maxRetries = 3;

handleRetry = () => {
  if (this.retryCount < this.maxRetries) {
    this.retryCount++;
    console.log(
      `Retrying Stream component (attempt ${this.retryCount}/${this.maxRetries})`
    );

    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
      errorType: "general",
    });
  } else {
    console.warn("Maximum retry attempts reached for Stream component");
  }
};
```

### Default Error UI

The boundary provides user-friendly error messages:

```typescript
const getErrorMessage = () => {
  if (!error) return "An unknown error occurred";

  // Authentication errors
  if (
    error.message.includes("token") ||
    error.message.includes("authentication")
  ) {
    return "Authentication failed. Please refresh the page to reconnect.";
  }

  // Network errors
  if (
    error.message.includes("network") ||
    error.message.includes("connection")
  ) {
    return "Network connection failed. Please check your internet and try again.";
  }

  // Permission errors
  if (error.message.includes("permission")) {
    return "Permission denied. Please ensure you have the necessary permissions.";
  }

  return error.message;
};
```

### Custom Error Handler

```typescript
function MyApp() {
  const handleStreamError = (error: Error, errorInfo: React.ErrorInfo) => {
    // Log to monitoring service
    Sentry.captureException(error, {
      contexts: {
        react: {
          componentStack: errorInfo.componentStack,
        },
      },
    });

    // Custom analytics
    analytics.track('stream_error', {
      message: error.message,
      stack: error.stack,
    });
  };

  return (
    <StreamErrorBoundary
      onError={handleStreamError}
      enableRetry={true}
    >
      <StreamApp />
    </StreamErrorBoundary>
  );
}
```

### Custom Fallback Component

```typescript
const CustomStreamError: React.FC<
  StreamErrorBoundaryState & { onRetry?: () => void }
> = ({ error, errorType, onRetry }) => {
  return (
    <div className="custom-error-container">
      <h2>Oops! Something went wrong</h2>
      <p>{error?.message}</p>

      {errorType === 'chat' && (
        <ChatErrorActions onRetry={onRetry} />
      )}

      {errorType === 'video' && (
        <VideoErrorActions onRetry={onRetry} />
      )}

      <ContactSupport error={error} />
    </div>
  );
};

<StreamErrorBoundary fallback={CustomStreamError}>
  <App />
</StreamErrorBoundary>
```

### Development Mode Features

In development, the error boundary shows technical details:

```typescript
{process.env.NODE_ENV === "development" && error && (
  <details className="mt-4 text-xs text-gray-500 max-w-md">
    <summary className="cursor-pointer hover:text-gray-700">
      Technical Details (Development Only)
    </summary>
    <pre className="mt-2 p-2 bg-gray-100 rounded text-left overflow-auto">
      {error.stack}
    </pre>
  </details>
)}
```

---

## Connection Retry Logic

The `StreamProvider` implements sophisticated connection retry with exponential backoff.

### Retry Configuration

```typescript
// Maximum connection attempts
const MAX_ATTEMPTS = 5;

// Exponential backoff calculation
const getRetryDelay = (attempt: number) => {
  return Math.min(1000 * Math.pow(2, attempt), 30000);
};

// Delay progression:
// Attempt 1: 1000ms  (1s)
// Attempt 2: 2000ms  (2s)
// Attempt 3: 4000ms  (4s)
// Attempt 4: 8000ms  (8s)
// Attempt 5: 16000ms (16s)
// Maximum: 30000ms   (30s)
```

### Implementation

```typescript
const connectServices = useCallback(
  async () => {
    if (isLoading || !userDetails || isConnecting) return;

    setIsConnecting(true);
    setError(null);

    try {
      const promises = [];
      if (enableChat && !chatConnected) promises.push(connectChat());
      if (enableVideo && !videoConnected) promises.push(connectVideo());

      await Promise.all(promises);
      setConnectionAttempts(0); // Reset on success
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Connection failed";
      setError(errorMessage);

      // Implement exponential backoff retry
      const newAttempts = connectionAttempts + 1;
      setConnectionAttempts(newAttempts);

      if (newAttempts < 5) {
        // Max 5 attempts
        const delay = getRetryDelay(newAttempts);
        console.log(
          `Retrying connection in ${delay}ms (attempt ${newAttempts})`,
        );
        setTimeout(() => {
          setIsConnecting(false);
          connectServices();
        }, delay);
        return;
      } else {
        console.error("Max connection attempts reached");
      }
    } finally {
      setIsConnecting(false);
    }
  },
  [
    /* dependencies */
  ],
);
```

### Manual Retry

```typescript
const retryConnection = useCallback(() => {
  setConnectionAttempts(0); // Reset counter
  setError(null);
  connectServices();
}, [connectServices]);

// Exposed via context
const connectionState: StreamConnectionState = {
  chatConnected,
  videoConnected,
  isConnecting,
  error,
  retryConnection, // Available to consumers
};
```

### Error State UI

After max attempts, show error UI with retry option:

```typescript
if (error && connectionAttempts >= 5) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[200px] p-4">
      <div className="text-red-600 text-center">
        <h3 className="font-semibold mb-2">Connection Failed</h3>
        <p className="text-sm mb-4">{error}</p>
        <button
          onClick={retryConnection}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          Retry Connection
        </button>
      </div>
    </div>
  );
}
```

---

## Error Categories

### 1. Authentication Errors

Errors related to tokens and user authentication.

#### Common Errors

| Error                   | Cause                     | Solution                           |
| ----------------------- | ------------------------- | ---------------------------------- |
| "Token expired"         | JWT token past expiration | Refresh token automatically        |
| "Invalid token"         | Malformed or wrong token  | Regenerate token with correct data |
| "Authentication failed" | User credentials invalid  | Re-authenticate user               |

#### Detection

```typescript
if (
  error.message.includes("token") ||
  error.message.includes("authentication")
) {
  // Handle authentication error
  await refreshToken();
}
```

#### Recovery Pattern

```typescript
async function handleAuthError(error: Error) {
  if (error.message.includes("token expired")) {
    console.log("Token expired, refreshing...");
    const newToken = await getCachedToken("chat");
    await reconnectWithToken(newToken);
    return true;
  }
  return false;
}
```

---

### 2. Network Errors

Connection and network-related failures.

#### Common Errors

| Error                    | Cause                  | Solution                    |
| ------------------------ | ---------------------- | --------------------------- |
| "Network request failed" | No internet connection | Wait and retry with backoff |
| "Connection timeout"     | Slow network           | Increase timeout, retry     |
| "WebSocket closed"       | Network interruption   | Reconnect automatically     |

#### Detection

```typescript
if (
  error.message.includes("network") ||
  error.message.includes("connection") ||
  error.message.includes("timeout")
) {
  // Handle network error
  await retryWithBackoff();
}
```

#### Recovery Pattern

```typescript
async function handleNetworkError(
  operation: () => Promise<void>,
  maxRetries = 5,
) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await operation();
      return;
    } catch (error) {
      if (attempt === maxRetries - 1) throw error;

      const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
      console.log(`Network error, retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
```

---

### 3. Permission Errors

Access control and authorization failures.

#### Common Errors

| Error                   | Cause                    | Solution               |
| ----------------------- | ------------------------ | ---------------------- |
| "Permission denied"     | User lacks required role | Check user permissions |
| "Channel access denied" | Not a member             | Add user to channel    |
| "Action not allowed"    | Insufficient privileges  | Verify user role       |

#### Detection

```typescript
if (error.message.includes("permission")) {
  // Handle permission error
  await checkUserPermissions();
}
```

#### Recovery Pattern

```typescript
async function handlePermissionError(userId: string, channelId: string) {
  try {
    // Check if user should have access
    const hasAccess = await checkUserAccess(userId, channelId);

    if (hasAccess) {
      // Add user to channel
      await addUserToChannel(userId, channelId);
      return true;
    } else {
      // Show permission denied message
      showPermissionDeniedError();
      return false;
    }
  } catch (error) {
    console.error("Failed to resolve permission error:", error);
    return false;
  }
}
```

---

### 4. Token Expiry

Specific handling for token expiration.

#### Token Cache Management

```typescript
const [tokenCache, setTokenCache] = useState<{
  chatToken?: string;
  videoToken?: string;
  expiresAt?: number;
}>({});

const isTokenValid = (type: "chat" | "video") => {
  const token = type === "chat" ? tokenCache.chatToken : tokenCache.videoToken;
  const expiresAt = tokenCache.expiresAt;

  if (!token || !expiresAt) return false;

  // Check if token expires within next 5 minutes
  return Date.now() < expiresAt - 5 * 60 * 1000;
};
```

#### Automatic Token Refresh

```typescript
const getCachedToken = async (type: "chat" | "video"): Promise<string> => {
  if (isTokenValid(type)) {
    return type === "chat" ? tokenCache.chatToken! : tokenCache.videoToken!;
  }

  // Generate new token
  const newToken =
    type === "chat"
      ? await chatTokenProvider(userId)
      : await tokenProvider(userId);

  // Cache with 50-minute expiry (tokens usually last 1 hour)
  const expiresAt = Date.now() + 50 * 60 * 1000;

  setTokenCache((prev) => ({
    ...prev,
    [`${type}Token`]: newToken,
    expiresAt,
  }));

  return newToken;
};
```

#### Token Provider Function

```typescript
await client.connectUser(
  {
    id: userDetails.id,
    name: userDetails.name ?? userDetails.id,
    image: userDetails.image ?? undefined,
    role: streamRole,
  },
  () => getCachedToken("chat"), // Function, not value
);
```

---

## Error Recovery Patterns

### Pattern 1: Automatic Retry

Used for transient errors that likely resolve themselves.

```typescript
async function automaticRetry<T>(
  operation: () => Promise<T>,
  options = {
    maxAttempts: 5,
    baseDelay: 1000,
    maxDelay: 30000,
  },
): Promise<T> {
  let lastError: Error;

  for (let attempt = 0; attempt < options.maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;

      // Don't retry on auth or permission errors
      if (
        lastError.message.includes("authentication") ||
        lastError.message.includes("permission")
      ) {
        throw lastError;
      }

      // Calculate delay with exponential backoff
      const delay = Math.min(
        options.baseDelay * Math.pow(2, attempt),
        options.maxDelay,
      );

      console.log(
        `Attempt ${attempt + 1}/${options.maxAttempts} failed, ` +
          `retrying in ${delay}ms...`,
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError!;
}

// Usage
const call = await automaticRetry(() =>
  client.call("default", callId).getOrCreate(),
);
```

### Pattern 2: User-Initiated Retry

Let users manually retry failed operations.

```typescript
function ErrorWithRetry({ error, onRetry }: {
  error: Error;
  onRetry: () => Promise<void>;
}) {
  const [isRetrying, setIsRetrying] = useState(false);

  const handleRetry = async () => {
    setIsRetrying(true);
    try {
      await onRetry();
    } catch (error) {
      console.error("Retry failed:", error);
    } finally {
      setIsRetrying(false);
    }
  };

  return (
    <Alert variant="destructive">
      <AlertTitle>Error</AlertTitle>
      <AlertDescription>{error.message}</AlertDescription>
      <Button
        onClick={handleRetry}
        disabled={isRetrying}
        className="mt-2"
      >
        {isRetrying ? "Retrying..." : "Try Again"}
      </Button>
    </Alert>
  );
}
```

### Pattern 3: Fallback UI

Show degraded functionality when errors occur.

```typescript
function ChatWithFallback() {
  const { chatConnected, error } = useStreamConnection();

  if (error) {
    return (
      <FallbackChatUI
        message="Chat temporarily unavailable"
        onRefresh={() => window.location.reload()}
      />
    );
  }

  if (!chatConnected) {
    return <ChatSkeleton />;
  }

  return <FullChatInterface />;
}

function FallbackChatUI({ message, onRefresh }: {
  message: string;
  onRefresh: () => void;
}) {
  return (
    <div className="text-center p-8">
      <MessageSquareOff className="mx-auto h-12 w-12 text-gray-400" />
      <p className="mt-4 text-gray-600">{message}</p>
      <Button onClick={onRefresh} className="mt-4">
        Refresh Page
      </Button>
    </div>
  );
}
```

### Pattern 4: Progressive Enhancement

Gradually enable features as connections succeed.

```typescript
function ProgressiveStreamApp() {
  const { chatConnected, videoConnected } = useStreamConnection();

  return (
    <div>
      {/* Always available */}
      <BasicUI />

      {/* Available when chat connected */}
      {chatConnected && <ChatFeatures />}

      {/* Available when video connected */}
      {videoConnected && <VideoFeatures />}

      {/* Available when both connected */}
      {chatConnected && videoConnected && <AdvancedFeatures />}
    </div>
  );
}
```

---

## Implementation Examples

### Complete Error Handling Flow

```typescript
function MeetingPage({ meetingId }: { meetingId: string }) {
  const { call, isCallLoading, error: callError } = useGetCallById(meetingId);
  const { chatConnected, videoConnected, error: connectionError } = useStreamConnection();
  const [retryCount, setRetryCount] = useState(0);

  const error = callError || connectionError;

  const handleRetry = async () => {
    setRetryCount(prev => prev + 1);

    if (callError) {
      // Retry getting call
      window.location.reload();
    } else if (connectionError) {
      // Use connection retry
      retryConnection();
    }
  };

  // Loading state
  if (isCallLoading) {
    return <MeetingLoadingSkeleton />;
  }

  // Error state with categorization
  if (error) {
    return (
      <ErrorDisplay
        error={error}
        retryCount={retryCount}
        onRetry={handleRetry}
        maxRetries={3}
      />
    );
  }

  // Not ready state
  if (!chatConnected || !videoConnected) {
    return (
      <ConnectionWaiting
        chatConnected={chatConnected}
        videoConnected={videoConnected}
      />
    );
  }

  // Success state
  return call ? (
    <StreamErrorBoundary>
      <MeetingRoom call={call} />
    </StreamErrorBoundary>
  ) : null;
}
```

### Comprehensive Error Display

```typescript
function ErrorDisplay({
  error,
  retryCount,
  onRetry,
  maxRetries
}: {
  error: Error;
  retryCount: number;
  onRetry: () => void;
  maxRetries: number;
}) {
  const errorCategory = categorizeError(error);

  return (
    <div className="error-container">
      <ErrorIcon category={errorCategory} />

      <h2>{getErrorTitle(errorCategory)}</h2>
      <p>{getErrorMessage(error, errorCategory)}</p>

      {retryCount > 0 && (
        <p className="text-sm text-gray-500">
          Retry attempt {retryCount} of {maxRetries}
        </p>
      )}

      <div className="actions">
        {retryCount < maxRetries && (
          <Button onClick={onRetry}>Try Again</Button>
        )}
        <Button variant="outline" onClick={() => router.push('/meetings')}>
          Back to Meetings
        </Button>
      </div>

      {process.env.NODE_ENV === 'development' && (
        <ErrorDebugInfo error={error} />
      )}
    </div>
  );
}

function categorizeError(error: Error): ErrorCategory {
  const message = error.message.toLowerCase();

  if (message.includes('token') || message.includes('auth')) {
    return 'authentication';
  }
  if (message.includes('network') || message.includes('connection')) {
    return 'network';
  }
  if (message.includes('permission')) {
    return 'permission';
  }
  if (message.includes('not found')) {
    return 'not_found';
  }
  return 'unknown';
}
```

---

## Next Steps

- Review [Troubleshooting Guide](./troubleshooting.md)
- Learn about [Hooks & Utilities](./11-hooks-utilities.md)
- Check [Recording & Webhooks](./13-recording-webhooks.md)

---

**Last Updated:** 2025-11-29
