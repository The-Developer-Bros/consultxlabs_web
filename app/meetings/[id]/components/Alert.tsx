"use client";

import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";

interface AlertProps {
  title: string;
  description?: string;
}

const Alert = ({ title, description }: AlertProps) => {
  const router = useRouter();

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4">
      <div className="w-full max-w-md bg-red-50 border border-red-200 rounded-lg p-6">
        <h1 className="text-xl font-semibold text-red-700 mb-4">{title}</h1>
        {description && <p className="text-muted-foreground mb-6">{description}</p>}
        <Button onClick={() => router.back()}>Go Back</Button>
      </div>
    </div>
  );
};

export default Alert;
