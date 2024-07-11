"use client";
// components/MultiStepForm.tsx
import { zodResolver } from "@hookform/resolvers/zod";
import React, { useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import ConsultantProfileForm from "../components/ConsultantProfileForm";
import ConsulteeProfileForm from "../components/ConsulteeProfileForm";
import PersonalInfoAndRoleForm from "../components/PersonalInfoAndRoleForm";
import StaffProfileForm from "../components/StaffProfileForm";
import { ConsultantProfile, ConsulteeProfile, PersonalInfoAndRole, personalInfoAndRoleSchema, StaffProfile } from "../schemas/userSchema";

type FormData = PersonalInfoAndRole & ConsultantProfile & ConsulteeProfile & StaffProfile;

const MultiStepForm: React.FC = () => {
  const [step, setStep] = useState(0);
  const methods = useForm<FormData>({ resolver: zodResolver(personalInfoAndRoleSchema) });

  const handleNext = (data: FormData) => {
    if (step === 0) {
      methods.trigger().then(isValid => {
        if (isValid) setStep(prevStep => prevStep + 1);
      });
    } else if (step === 1) {
      if (methods.getValues().role === "CONSULTANT") {
        methods.trigger().then(isValid => {
          if (isValid) setStep(prevStep => prevStep + 1);
        });
      } else if (methods.getValues().role === "CONSULTEE") {
        methods.trigger().then(isValid => {
          if (isValid) setStep(prevStep => prevStep + 2);
        });
      } else {
        methods.trigger().then(isValid => {
          if (isValid) setStep(prevStep => prevStep + 3);
        });
      }
    }
  };

  const handleBack = () => setStep(prevStep => prevStep - 1);

  const handleSubmit = (data: FormData) => {
    console.log("Submitted Data:", data);
    // Handle form submission here
  };

  return (
    <FormProvider {...methods}>
      <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50">
        <header className="flex items-center space-x-2 mb-8">
          <LogInIcon className="w-8 h-8 text-primary" />
          <h1 className="text-2xl font-bold">ConsultX</h1>
        </header>
        <div className="flex items-center space-x-4 mb-8">
          <div className={`flex items-center justify-center w-10 h-10 rounded-full ${step === 0 ? "bg-black text-white" : "bg-gray-200 text-gray-500"}`}>1</div>
          <div className="w-10 h-0.5 bg-gray-300" />
          <div className={`flex items-center justify-center w-10 h-10 rounded-full ${step === 1 ? "bg-black text-white" : "bg-gray-200 text-gray-500"}`}>2</div>
          <div className="w-10 h-0.5 bg-gray-300" />
          <div className={`flex items-center justify-center w-10 h-10 rounded-full ${step === 2 ? "bg-black text-white" : "bg-gray-200 text-gray-500"}`}>3</div>
          <div className="w-10 h-0.5 bg-gray-300" />
          <div className={`flex items-center justify-center w-10 h-10 rounded-full ${step === 3 || step === 4 ? "bg-black text-white" : "bg-gray-200 text-gray-500"}`}>4</div>
        </div>
        <div className="text-center mb-8">
          <h2 className="text-2xl font-bold">Welcome! First things first...</h2>
          <p className="text-muted-foreground">You can always change them later.</p>
        </div>
        {step === 0 && <PersonalInfoAndRoleForm onNext={() => handleNext(methods.getValues())} />}
        {step === 1 && methods.getValues().role === "CONSULTANT" && <ConsultantProfileForm onNext={() => handleNext(methods.getValues())} onBack={handleBack} />}
        {step === 2 && methods.getValues().role === "CONSULTEE" && <ConsulteeProfileForm onNext={() => handleNext(methods.getValues())} onBack={handleBack} />}
        {step === 3 && methods.getValues().role === "STAFF" && <StaffProfileForm onSubmit={methods.handleSubmit(handleSubmit)} onBack={handleBack} />}
      </div>
    </FormProvider>
  );
};

function LogInIcon(props: any) {
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

export default MultiStepForm;
