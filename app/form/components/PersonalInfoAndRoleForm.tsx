import React from "react";
import { useFormContext } from "react-hook-form";
import { PersonalInfoAndRole } from "../schemas/userSchema";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface Props {
  onNext: () => void;
}

const PersonalInfoAndRoleForm: React.FC<Props> = ({ onNext }) => {
  const {
    register,
    handleSubmit,
    formState: { errors },
    setValue,
    getValues,
  } = useFormContext<PersonalInfoAndRole>();

  const handleRoleSelect = (role: "CONSULTANT" | "CONSULTEE" | "STAFF") => {
    setValue("role", role);
  };

  return (
    <form onSubmit={handleSubmit(onNext)} className="w-full max-w-md space-y-4">
      <div className="flex justify-center space-x-4 mb-8">
        <Button
          variant={getValues("role") === "CONSULTEE" ? "night" : "outline"}
          className="w-32"
          onClick={() => handleRoleSelect("CONSULTEE")}
        >
          Consultee
        </Button>
        <Button
          variant={getValues("role") === "CONSULTANT" ? "night" : "outline"}
          className="w-32"
          onClick={() => handleRoleSelect("CONSULTANT")}
        >
          Consultant
        </Button>
        <Button
          variant={getValues("role") === "STAFF" ? "night" : "outline"}
          className="w-32"
          onClick={() => handleRoleSelect("STAFF")}
        >
          Staff
        </Button>
      </div>
      <div className="space-y-2">
        <Label htmlFor="name">Full Name</Label>
        <Input id="name" placeholder="Steve Jobs" {...register("name")} />
        {errors.name && <p className="text-red-500">{errors.name.message}</p>}
      </div>
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          placeholder="example@domain.com"
          {...register("email")}
        />
        {errors.email && <p className="text-red-500">{errors.email.message}</p>}
      </div>
      <Button type="submit" variant="night" className="w-full">
        Next
      </Button>
    </form>
  );
};

function LogInIcon(props: React.JSX.IntrinsicAttributes & React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
      <polyline points="10 17 15 12 10 7" />
      <line x1="15" x2="3" y1="12" y2="12" />
    </svg>
  );
}

export default PersonalInfoAndRoleForm;
