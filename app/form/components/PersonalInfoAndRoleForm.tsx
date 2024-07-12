import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import React from "react";
import { useFormContext, useWatch } from "react-hook-form";
import { PersonalInfoAndRole } from "../schemas/userSchema";

interface Props {
  onNext: () => void;
}
const PersonalInfoAndRoleForm: React.FC<Props> = ({ onNext }) => {
  const {
    register,
    handleSubmit,
    formState: { errors },
    setValue,
    control,
  } = useFormContext<PersonalInfoAndRole>();

  const role = useWatch({
    control,
    name: "role",
  });

  const handleRoleSelect = (selectedRole: "CONSULTANT" | "CONSULTEE" | "STAFF") => {
    setValue("role", selectedRole, { shouldValidate: true });
  };

  return (
    <form onSubmit={handleSubmit(onNext)} className="w-full max-w-md space-y-4">
      <div className="flex justify-center space-x-4 mb-8">
        <Button
          type="button"
          variant={role === "CONSULTEE" ? "night" : "outline"}
          className="w-32"
          onClick={() => handleRoleSelect("CONSULTEE")}
        >
          Consultee
        </Button>
        <Button
          type="button"
          variant={role === "CONSULTANT" ? "night" : "outline"}
          className="w-32"
          onClick={() => handleRoleSelect("CONSULTANT")}
        >
          Consultant
        </Button>
        <Button
          type="button"
          variant={role === "STAFF" ? "night" : "outline"}
          className="w-32"
          onClick={() => handleRoleSelect("STAFF")}
        >
          Staff
        </Button>
      </div>
      <div className="space-y-2">
        <Label htmlFor="name">Full Name</Label>
        <Input id="name" {...register("name", { required: "Name is required" })} />
        {errors.name && <p className="text-red-500">{errors.name.message}</p>}
      </div>
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" {...register("email", { required: "Email is required" })} />
        {errors.email && <p className="text-red-500">{errors.email.message}</p>}
      </div>
      <div className="space-y-2">
        <Label htmlFor="phone">Phone</Label>
        <Input id="phone" {...register("phone")} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="address">Address</Label>
        <Input id="address" {...register("address")} />
      </div>
      <Button type="submit" variant="night" className="w-full">Next</Button>
    </form>
  );
};


export default PersonalInfoAndRoleForm;
