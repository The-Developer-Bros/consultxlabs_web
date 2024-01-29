"use client";
/**
 * This code was generated by v0 by Vercel.
 * @see https://v0.dev/t/UpVHTEbiJ8P
 */
import { Button } from "@/components/ui/button"
import { SelectValue, SelectTrigger, SelectItem, SelectContent, Select } from "@/components/ui/select"
import { AvatarImage, Avatar } from "@/components/ui/avatar"

import { format, startOfWeek,endOfWeek, addDays, startOfMonth, endOfMonth, eachDayOfInterval } from 'date-fns';

export default function ConsultantAvailabilityCalendar() {
  const monthStart = startOfMonth(new Date());
  const monthEnd = endOfMonth(new Date());
  const startDate = startOfWeek(monthStart);
  const endDate = endOfWeek(monthEnd);

  const dateFormat = "d";
  const rows = [];

  let days = [];
  let day = startDate;
  let formattedDate = "";

  while (day <= endDate) {
    for (let i = 0; i < 7; i++) {
      formattedDate = format(day, dateFormat);
      const cloneDay = day;
      days.push(
        <div className="col cell">
          <span className="number">{formattedDate}</span>
          <span className="bg">{formattedDate}</span>
        </div>
      );
      day = addDays(day, 1);
    }
    rows.push(
      <div className="row">
        {days}
      </div>
    );
    days = [];
  }
  
  return (
    <div className="bg-white p-6">
      <div className="flex items-center justify-between mb-4">
        <Button className="rounded-full bg-blue-500 text-white" variant="ghost">
          Today
        </Button>
        <div className="flex items-center space-x-2">
          <ChevronLeftIcon className="h-6 w-6 text-gray-600" />
          <h2 className="text-xl font-semibold">January 2024</h2>
          <ChevronRightIcon className="h-6 w-6 text-gray-600" />
        </div>
        <div className="flex items-center space-x-4">
          <SearchIcon className="h-6 w-6 text-gray-600" />
          <SettingsIcon className="h-6 w-6 text-gray-600" />
          <Select>
            <SelectTrigger id="view-select">
              <SelectValue placeholder="Month" />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value="day">Day</SelectItem>
              <SelectItem value="week">Week</SelectItem>
              <SelectItem value="month">Month</SelectItem>
            </SelectContent>
          </Select>
          <PlusIcon className="h-6 w-6 text-gray-600" />
        </div>
      </div>
      <div className="grid grid-cols-7 gap-4 text-xs font-medium text-gray-500">
        <div>MON</div>
        <div>TUE</div>
        <div>WED</div>
        <div>THU</div>
        <div>FRI</div>
        <div>SAT</div>
        <div>SUN</div>
      </div>
      <div className="grid grid-cols-7 gap-4 mt-2">
        <div>
          <div className="text-sm">Jan 1</div>
          <div className="bg-green-200 p-2 mt-1 rounded">New Year's Day</div>
        </div>
        <div className="text-sm">2</div>
        <div>
          <div className="text-sm">3</div>
          <div className="bg-green-200 p-2 mt-1 rounded">2:45 Flight to Bengaluru (QP 1409)</div>
        </div>
        <div className="text-sm">4</div>
        <div className="text-sm">5</div>
        <div className="text-sm">6</div>
        <div>
          <div className="text-sm">7</div>
          <div className="relative">
            <div className="absolute top-0 right-0">
              <Avatar>
                <AvatarImage alt="User Avatar" src="/placeholder.svg?height=32&width=32" />
              </Avatar>
            </div>
          </div>
        </div>
        <div className="text-sm">8</div>
        <div className="text-sm">9</div>
        <div className="text-sm">10</div>
        <div className="text-sm">11</div>
        <div className="text-sm">12</div>
        <div>
          <div className="text-sm">13</div>
          <div className="bg-green-200 p-2 mt-1 rounded">Lohri</div>
        </div>
        <div>
          <div className="text-sm">14</div>
          <div className="bg-green-200 p-2 mt-1 rounded">Makar Sankranti</div>
        </div>
        <div>
          <div className="text-sm">15</div>
          <div className="bg-green-200 p-2 mt-1 rounded">Pongal</div>
        </div>
        <div>
          <div className="text-sm">16</div>
          <div className="bg-green-200 p-2 mt-1 rounded">2:10 Flight to Bengaluru (AI 504)</div>
        </div>
        <div>
          <div className="text-sm">17</div>
          <div className="bg-green-200 p-2 mt-1 rounded">Guru Govind Singh Jayanti</div>
        </div>
        <div className="text-sm">18</div>
        <div className="text-sm">19</div>
        <div className="text-sm">20</div>
        <div className="text-sm">21</div>
        <div className="text-sm">22</div>
        <div className="text-sm">23</div>
        <div className="text-sm">24</div>
        <div>
          <div className="text-sm">25</div>
          <div className="bg-green-200 p-2 mt-1 rounded">Hazrat Ali's Birthday</div>
        </div>
        <div>
          <div className="text-sm">26</div>
          <div className="bg-green-200 p-2 mt-1 rounded">Republic Day</div>
        </div>
        <div className="text-sm">27</div>
        <div className="text-sm">28</div>
        <div className="text-sm">29</div>
        <div className="text-sm">30</div>
        <div className="text-sm">31</div>
        <div className="text-sm">Feb 1</div>
        <div className="text-sm">2</div>
        <div className="text-sm">3</div>
        <div className="text-sm">4</div>
      </div>
    </div>
  )
}


function ChevronLeftIcon(props) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m15 18-6-6 6-6" />
    </svg>
  )
}


function ChevronRightIcon(props) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}


function SearchIcon(props) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  )
}


function SettingsIcon(props) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12.22 2h-.44a2 2 0 0-2 2v.18a2 1-1 1.73l-.43.25a2 1-2 0l-.15-.08a2 0-2.73.73l-.22.38a2 .73 2.73l.15.1a2 1 1.72v.51a2 1.74l-.15.09a2 0-.73 2.73l.22.38a2 2.73.73l.15-.08a2 0l.43.25a2 1.73V20a2 2h.44a2 2-2v-.18a2 1-1.73l.43-.25a2 0l.15.08a2 2.73-.73l.22-.39a2 0-.73-2.73l-.15-.08a2 1-1-1.74v-.5a2 1-1.74l.15-.09a2 .73-2.73l-.22-.38a2 0-2.73-.73l-.15.08a2 0l-.43-.25a2 1-1-1.73V4a2 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}


function PlusIcon(props) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </svg>
  )
}
