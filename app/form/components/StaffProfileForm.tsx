// components/StaffProfileForm.tsx
import React from "react";
import { useFormContext } from "react-hook-form";
import { StaffProfile } from "../schemas/userSchema";

interface Props {
  onSubmit: () => void;
  onBack: () => void;
}

const StaffProfileForm: React.FC<Props> = ({ onSubmit, onBack }) => {
  const { register, handleSubmit, formState: { errors } } = useFormContext<StaffProfile>();

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <div>
        <label>Department</label>
        <input {...register("department")} />
        {errors.department && <p>{errors.department.message}</p>}
      </div>
      <div>
        <label>Position</label>
        <input {...register("position")} />
        {errors.position && <p>{errors.position.message}</p>}
      </div>
      <button type="button" onClick={onBack}>Back</button>
      <button type="submit">Submit</button>
    </form>
  );
};

export default StaffProfileForm;