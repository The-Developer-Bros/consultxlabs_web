// components/RoleForm.tsx
import React from "react";
import { useFormContext } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { RoleInfo, roleSchema } from "../schemas/userSchema";

interface Props {
  onNext: () => void;
  onBack: () => void;
}

const RoleForm: React.FC<Props> = ({ onNext, onBack }) => {
  const { register, handleSubmit, formState: { errors } } = useFormContext<RoleInfo>();

  return (
    <form onSubmit={handleSubmit(onNext)}>
      <div>
        <label>Role</label>
        <select {...register("role")}>
          <option value="CONSULTANT">Consultant</option>
          <option value="CONSULTEE">Consultee</option>
          <option value="STAFF">Staff</option>
        </select>
        {errors.role && <p>{errors.role.message}</p>}
      </div>
      <button type="button" onClick={onBack}>Back</button>
      <button type="submit">Next</button>
    </form>
  );
};

export default RoleForm;