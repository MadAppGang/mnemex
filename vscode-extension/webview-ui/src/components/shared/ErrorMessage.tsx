import React from 'react';

interface ErrorMessageProps {
  message: string;
}

export function ErrorMessage({ message }: ErrorMessageProps): React.JSX.Element {
  return (
    <div className="error" role="alert">
      {message}
    </div>
  );
}
