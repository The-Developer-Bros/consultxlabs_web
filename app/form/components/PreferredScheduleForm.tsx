import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import React, { useState } from "react";
import { useFormContext } from "react-hook-form";

interface Props {
  onNext: () => void;
  onBack: () => void;
}

const PreferredScheduleForm: React.FC<Props> = ({ onNext, onBack }) => {
  const { register, handleSubmit, watch, setValue, formState: { errors } } = useFormContext();
  const scheduleType = watch("scheduleType");
  const [weeklySlots, setWeeklySlots] = useState<Record<string, Array<{ startTime: string; endTime: string }>>>({});
  const [customSlots, setCustomSlots] = useState<Array<{ day: Date; startTime: string; endTime: string }>>([]);

  const handleAddWeeklySlot = (day: string) => {
    setWeeklySlots(prev => ({
      ...prev,
      [day]: [...(prev[day] || []), { startTime: '', endTime: '' }]
    }));
  };

  const handleUpdateWeeklySlot = (day: string, index: number, field: 'startTime' | 'endTime', value: string) => {
    setWeeklySlots(prev => ({
      ...prev,
      [day]: prev[day].map((slot, i) => i === index ? { ...slot, [field]: value } : slot)
    }));
    setValue('weeklySlots', weeklySlots);
  };

  const handleAddCustomSlot = (day: Date) => {
    setCustomSlots(prev => [...prev, { day, startTime: '', endTime: '' }]);
    setValue('customSlots', customSlots);
  };

  const handleUpdateCustomSlot = (index: number, field: 'startTime' | 'endTime', value: string) => {
    setCustomSlots(prev => prev.map((slot, i) => i === index ? { ...slot, [field]: value } : slot));
    setValue('customSlots', customSlots);
  };

  return (
    <form onSubmit={handleSubmit(onNext)} className="w-full max-w-md">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Preferred Schedule</CardTitle>
          <CardDescription>Choose how you'd like to schedule your appointments.</CardDescription>
        </CardHeader>
        <CardContent>
          <RadioGroup defaultValue="weekly" {...register("scheduleType")}>
            <div className="flex items-center justify-between">
              <Label htmlFor="weekly" className="font-medium">Weekly Recurring</Label>
              <RadioGroupItem id="weekly" value="weekly" />
            </div>
            <div className={`grid gap-4 mt-4 ${scheduleType !== 'weekly' ? "opacity-50 pointer-events-none" : ""}`}>
              {['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((day) => (
                <div key={day} className="grid gap-2">
                  <Label>{day}</Label>
                  {weeklySlots[day]?.map((slot, index) => (
                    <div key={index} className="grid grid-cols-2 gap-2">
                      <Input
                        type="time"
                        value={slot.startTime}
                        onChange={(e) => handleUpdateWeeklySlot(day, index, 'startTime', e.target.value)}
                      />
                      <Input
                        type="time"
                        value={slot.endTime}
                        onChange={(e) => handleUpdateWeeklySlot(day, index, 'endTime', e.target.value)}
                      />
                    </div>
                  ))}
                  <Button type="button" variant="outline" onClick={() => handleAddWeeklySlot(day)}>
                    Add Slot
                  </Button>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between mt-6">
              <Label htmlFor="custom" className="font-medium">Custom Schedule</Label>
              <RadioGroupItem id="custom" value="custom" />
            </div>
            <div className={`grid gap-4 mt-4 ${scheduleType !== 'custom' ? "opacity-50 pointer-events-none" : ""}`}>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline">
                    Pick dates
                    <CalendarDaysIcon className="ml-auto h-4 w-4 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="multiple"
                    selected={customSlots.map(slot => slot.day)}
                    onSelect={(days) => {
                      if (days) {
                        days.forEach(day => {
                          if (!customSlots.some(slot => slot.day.getTime() === day.getTime())) {
                            handleAddCustomSlot(day);
                          }
                        });
                      }
                    }}
                  />
                </PopoverContent>
              </Popover>
              {customSlots.map((slot, index) => (
                <div key={index} className="grid grid-cols-3 gap-2">
                  <div>{slot.day.toDateString()}</div>
                  <Input
                    type="time"
                    value={slot.startTime}
                    onChange={(e) => handleUpdateCustomSlot(index, 'startTime', e.target.value)}
                  />
                  <Input
                    type="time"
                    value={slot.endTime}
                    onChange={(e) => handleUpdateCustomSlot(index, 'endTime', e.target.value)}
                  />
                </div>
              ))}
            </div>
          </RadioGroup>
        </CardContent>
        <CardFooter className="flex justify-between">
          <Button type="button" onClick={onBack} variant="outline">Back</Button>
          <Button type="submit" variant="night">Next</Button>
        </CardFooter>
      </Card>
    </form>
  );
};

function CalendarDaysIcon(props: React.JSX.IntrinsicAttributes & React.SVGProps<SVGSVGElement>) {
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
      <path d="M8 2v4" />
      <path d="M16 2v4" />
      <rect width="18" height="18" x="3" y="4" rx="2" />
      <path d="M3 10h18" />
      <path d="M8 14h.01" />
      <path d="M12 14h.01" />
      <path d="M16 14h.01" />
      <path d="M8 18h.01" />
      <path d="M12 18h.01" />
      <path d="M16 18h.01" />
    </svg>
  )
}

export default PreferredScheduleForm;